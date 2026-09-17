import type { BridgeConfig } from '@voxdock/config';
import type { ConsoleConfigurationUpdate } from '@voxdock/contracts';
import { DomainError, type CallStore } from '@voxdock/core';
import type { Runtime, RuntimeFactory } from './cli-service.js';
import type { ConfigurationStore } from './configuration-store.js';

/** Serializes every configuration/pairing change with call admission. */
export class RuntimeManager {
  private busy = false;
  private runtime: Runtime | undefined;
  constructor(readonly config: BridgeConfig, private readonly store: CallStore, private readonly directory: string, private readonly factory: RuntimeFactory, readonly configuration: ConfigurationStore) {}
  async start(): Promise<void> { this.runtime = await this.factory({ config: structuredClone(this.config), store: this.store, configDirectory: this.directory }); }
  get readyChannels() { return this.runtime?.readyChannels ?? new Set<never>(); }
  get managing() { return this.busy; }
  private claim(): void {
    if (this.busy) throw new DomainError('management_busy', 409);
    if (this.store.listCalls().some(call => call.state !== 'ended')) throw new DomainError('active_or_uncertain_call', 409);
    this.busy = true;
    this.store.setPaused(true);
  }
  async apply(input: ConsoleConfigurationUpdate) {
    this.claim();
    let stopped = false;
    let candidate: Runtime | undefined;
    try {
      const prepared = this.configuration.prepare(input);
      await this.runtime?.close(); this.runtime = undefined; stopped = true;
      candidate = await this.factory({ config: prepared.config, store: this.store, configDirectory: this.directory });
      prepared.commit();
      Object.assign(this.config, prepared.config);
      if (!prepared.config.backend) delete this.config.backend;
      this.store.setTranscriptCapture(this.config.records.transcript_retention_days > 0);
      this.runtime = candidate;
      return this.configuration.view();
    } catch (error) {
      if (stopped) {
        await candidate?.close().catch(() => {});
        try { await this.start(); } catch { this.runtime = undefined; }
        throw new DomainError('runtime_apply_failed', 503);
      }
      throw error;
    } finally { this.busy = false; }
  }
  async acquire(): Promise<(safe: boolean) => Promise<void>> {
    this.claim();
    try { await this.runtime?.close(); this.runtime = undefined; }
    catch { throw new DomainError('runtime_stop_failed', 503); }
    let released = false;
    return async safe => {
      if (released) return;
      released = true;
      if (!safe) return;
      try { await this.start(); } finally { this.busy = false; }
    };
  }
  onCallCreated: Runtime['onCallCreated'] = async call => { if (!this.runtime || this.busy) throw new DomainError('management_busy', 409); await this.runtime.onCallCreated(call); };
  onEnd: Runtime['onEnd'] = async call => { await this.runtime?.onEnd(call); };
  onResult: Runtime['onResult'] = async result => { await this.runtime?.onResult(result); };
  async close(): Promise<void> { await this.runtime?.close(); this.runtime = undefined; }
}
