import type { BridgeConfig } from '@voxdock/config';
import type { ConsoleConfigurationUpdate } from '@voxdock/contracts';
import { DomainError, type CallStore } from '@voxdock/core';
import type { Runtime, RuntimeFactory } from './cli-service.js';
import type { ConfigurationStore } from './configuration-store.js';

/** Serializes every configuration/pairing change with call admission. */
export class RuntimeManager {
  private busy = false;
  private runtime: Runtime | undefined;
  private closing = false;
  private starting: Promise<void> | undefined;
  private operation: Promise<unknown> | undefined;
  constructor(readonly config: BridgeConfig, private readonly store: CallStore, private readonly directory: string, private readonly factory: RuntimeFactory, readonly configuration: ConfigurationStore) {}
  async start(): Promise<void> {
    if (this.closing) throw new DomainError('service_closing', 503);
    this.starting = (async () => {
      const next = await this.factory({ config: structuredClone(this.config), store: this.store, configDirectory: this.directory });
      this.runtime = next;
      if (this.closing) await this.stop();
    })();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  get readyChannels() { return this.runtime?.readyChannels ?? new Set<never>(); }
  get managing() { return this.busy; }
  private claim(): void {
    if (this.closing) throw new DomainError('service_closing', 503);
    if (this.busy) throw new DomainError('management_busy', 409);
    if (this.store.listCalls().some(call => call.state !== 'ended')) throw new DomainError('active_or_uncertain_call', 409);
    this.busy = true;
    this.store.setPaused(true);
  }
  apply(input: ConsoleConfigurationUpdate) {
    if (this.busy) return Promise.reject(new DomainError('management_busy', 409));
    const operation = this.applyChange(input);
    this.operation = operation;
    return operation.finally(() => { if (this.operation === operation) this.operation = undefined; });
  }
  private async applyChange(input: ConsoleConfigurationUpdate) {
    if (this.closing) throw new DomainError('service_closing', 503);
    if (this.busy) throw new DomainError('management_busy', 409);
    if (this.store.listCalls().some(call => call.state !== 'ended')) throw new DomainError('active_or_uncertain_call', 409);
    const prepared = this.configuration.prepare(input);
    this.claim();
    await this.stop();
    return this.install(prepared);
  }
  private async stop(): Promise<void> {
    try { await this.runtime?.close(); }
    catch { throw new DomainError('runtime_stop_failed', 503); }
    this.runtime = undefined;
  }
  /** The caller owns the lease and has already stopped the previous runtime. */
  private async install(prepared: ReturnType<ConfigurationStore['prepare']>) {
    let cleanupUnknown = false;
    let candidate: Runtime | undefined;
    try {
      if (this.closing) throw new DomainError('service_closing', 503);
      candidate = await this.factory({ config: prepared.config, store: this.store, configDirectory: this.directory });
      if (this.closing) throw new DomainError('service_closing', 503);
      prepared.commit();
      Object.assign(this.config, prepared.config);
      if (!prepared.config.backend) delete this.config.backend;
      this.store.setTranscriptCapture(this.config.records.transcript_retention_days > 0);
      this.runtime = candidate;
      return this.configuration.view();
    } catch {
      try { await candidate?.close(); }
      catch { this.runtime = candidate; cleanupUnknown = true; throw new DomainError('runtime_stop_failed', 503); }
      if (!this.closing) { try { await this.start(); } catch { cleanupUnknown = this.runtime !== undefined; } }
      if (this.closing) throw new DomainError('service_closing', 503);
      throw new DomainError('runtime_apply_failed', 503);
    } finally { this.busy = cleanupUnknown; }
  }
  acquire(): Promise<(safe: boolean, update?: ConsoleConfigurationUpdate) => Promise<void>> {
    if (this.busy) return Promise.reject(new DomainError('management_busy', 409));
    const operation = this.acquireLease();
    this.operation = operation;
    return operation.finally(() => { if (this.operation === operation) this.operation = undefined; });
  }
  private async acquireLease(): Promise<(safe: boolean, update?: ConsoleConfigurationUpdate) => Promise<void>> {
    this.claim();
    await this.stop();
    if (this.closing) throw new DomainError('service_closing', 503);
    let release: Promise<void> | undefined;
    return (safe, update) => {
      if (release) return release;
      release = this.releaseLease(safe, update);
      const operation = release;
      this.operation = operation;
      release = operation.finally(() => { if (this.operation === operation) this.operation = undefined; });
      return release;
    };
  }
  private async releaseLease(safe: boolean, update?: ConsoleConfigurationUpdate): Promise<void> {
    if (!safe) return;
    if (this.closing) throw new DomainError('service_closing', 503);
    if (update) {
      let prepared: ReturnType<ConfigurationStore['prepare']>;
      try { prepared = this.configuration.prepare(update); }
      catch (error) {
        try { await this.start(); } catch { /* Preserve the configuration validation error. */ }
        finally { this.busy = false; }
        throw error;
      }
      await this.install(prepared);
    } else {
      try { await this.start(); } finally { this.busy = false; }
    }
  }
  onCallCreated: Runtime['onCallCreated'] = async call => { if (!this.runtime || this.busy) throw new DomainError('management_busy', 409); await this.runtime.onCallCreated(call); };
  onEnd: Runtime['onEnd'] = async call => { await this.runtime?.onEnd(call); };
  onResult: Runtime['onResult'] = async result => { await this.runtime?.onResult(result); };
  async close(): Promise<void> {
    this.closing = true;
    await this.operation?.catch(() => {});
    await this.starting?.catch(() => {});
    await this.runtime?.close(); this.runtime = undefined;
  }
}
