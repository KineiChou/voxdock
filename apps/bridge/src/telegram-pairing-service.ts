import { randomBytes, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type { ConsoleConfigurationUpdate, ConsoleConfigurationView, TelegramPairingIdentity, TelegramSetup, TelegramTargetPairing } from '@voxdock/contracts';
import { DomainError } from '@voxdock/core';
import { TelegramCleanupError, type TelegramAccountConfig } from '../../../packages/telegram/src/account.js';
import type { PairingRelease } from './target-pairing-service.js';

export interface TelegramPairingObserver {
  account: TelegramPairingIdentity;
  candidate(): TelegramPairingIdentity | undefined;
  confirm(userId: string): Promise<void>;
  close(): Promise<void>;
}
type Observe = (config: TelegramAccountConfig, input: { method: 'message' | 'call'; code?: string; expires_at: string }, signal?: AbortSignal) => Promise<TelegramPairingObserver>;
export interface TelegramPairingDependencies {
  acquire(): Promise<PairingRelease>;
  configuration(): ConsoleConfigurationView;
  getTelegramConfig(): Promise<TelegramAccountConfig>;
  observe?: Observe;
  ttlMs?: number;
}
interface Flow {
  view: TelegramTargetPairing;
  observer: TelegramPairingObserver;
  release: PairingRelease;
  released: boolean;
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
}
const terminal = (view: TelegramTargetPairing) => ['completed', 'cancelled', 'expired', 'failed'].includes(view.state);
const cleanupUnknown = (error: unknown) => error instanceof TelegramCleanupError;
// Whitelist public profile fields even if a native observer carries private peer metadata.
function identity(value: TelegramPairingIdentity): TelegramPairingIdentity {
  if (!/^[1-9][0-9]{0,18}$/.test(value.user_id)) throw new DomainError('invalid_telegram_target', 409);
  return { user_id: value.user_id, display_name: value.display_name, ...(value.username ? { username: value.username } : {}), ...(value.phone ? { phone: value.phone } : {}) };
}
async function observe(config: TelegramAccountConfig, input: Parameters<Observe>[1], signal?: AbortSignal) {
  const native = await import('../../../packages/telegram/src/pairing.js');
  return native.observeTelegramPairing(config, input, signal);
}

/** A temporary observer exclusively owns the stopped runtime until explicit confirmation. */
export class TelegramPairingService {
  private current?: Flow;
  private pending: AbortController | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly ttl: number;
  constructor(private readonly dependencies: TelegramPairingDependencies) { this.ttl = Math.min(180000, Math.max(1000, dependencies.ttlMs ?? 180000)); }
  private serial<T>(action: () => Promise<T>): Promise<T> { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  private checkOpen() { if (this.closing) throw new DomainError('service_closing', 503); }
  private get(id: string) { if (!this.current || this.current.view.id !== id) throw new DomainError('target_pairing_not_found', 404); return this.current; }
  private copy(flow: Flow) { return structuredClone(flow.view); }
  private async release(flow: Flow, safe: boolean, update?: ConsoleConfigurationUpdate) {
    if (flow.released) return;
    flow.released = true; clearTimeout(flow.timer); delete flow.view.code;
    await flow.release(safe, update);
  }
  async setup(): Promise<TelegramSetup> {
    const target = this.dependencies.configuration().settings.targets.find(target => target.channel === 'telegram');
    const result: TelegramSetup = { linked: false, credentials_ready: false, pairing_available: false, target: target ? { user_id: target.peer_id, enabled: target.enabled } : null };
    try {
      const config = await this.dependencies.getTelegramConfig();
      result.credentials_ready = Number.isSafeInteger(config.apiId) && config.apiId > 0 && !!config.apiHash;
      await access(config.sessionFile); result.linked = true; result.pairing_available = result.credentials_ready;
    } catch { /* Setup reads never connect, authenticate or create a session. */ }
    return result;
  }
  start(method: TelegramTargetPairing['method']): Promise<TelegramTargetPairing> {
    return this.serial(async () => {
      this.checkOpen();
      if (!['message', 'call'].includes(method)) throw new DomainError('invalid_pairing_method', 400);
      if (this.current && !terminal(this.current.view)) throw new DomainError('target_pairing_active', 409);
      const release = await this.dependencies.acquire();
      const controller = new AbortController(); this.pending = controller;
      const expires_at = new Date(Date.now() + this.ttl).toISOString();
      const code = method === 'message' ? `VOX-${randomBytes(6).toString('hex').toUpperCase()}` : undefined;
      const timer = setTimeout(() => {
        controller.abort();
        void this.serial(async () => { if (this.current?.controller === controller && !terminal(this.current.view)) await this.cancelFlow(this.current, true); }).catch(() => {});
      }, this.ttl); timer.unref();
      let observer: TelegramPairingObserver | undefined;
      let flow: Flow | undefined;
      try {
        this.checkOpen();
        const config = await this.dependencies.getTelegramConfig(); controller.signal.throwIfAborted();
        observer = await (this.dependencies.observe ?? observe)(config, { method, expires_at, ...(code ? { code } : {}) }, controller.signal);
        flow = { view: { id: randomUUID(), method, expires_at, state: 'waiting', account: identity(observer.account), ...(code ? { code } : {}) }, observer, controller, release, released: false, timer };
        this.current = flow;
        if (this.closing || controller.signal.aborted) return this.cancelFlow(flow, !this.closing);
        this.refresh(flow);
        return this.copy(flow);
      } catch (error) {
        let safe = !cleanupUnknown(error);
        try { await observer?.close(); } catch { safe = false; }
        if (flow) { flow.view.state = 'failed'; flow.view.error = safe ? 'target_pairing_unavailable' : 'target_pairing_cleanup_required'; await this.release(flow, safe); }
        else { clearTimeout(timer); await release(safe); }
        if (safe && error instanceof DomainError) throw error;
        throw new DomainError(safe ? 'target_pairing_unavailable' : 'target_pairing_cleanup_required', 503);
      } finally { if (this.pending === controller) this.pending = undefined; }
    });
  }
  private refresh(flow: Flow) {
    const observed = flow.observer.candidate();
    if (!observed) { if (flow.view.candidate) throw new DomainError('target_pairing_changed', 409); return; }
    const candidate = identity(observed);
    if (candidate.user_id === flow.view.account.user_id) throw new DomainError('target_must_differ', 409);
    if (flow.view.candidate && candidate.user_id !== flow.view.candidate.user_id) throw new DomainError('target_pairing_changed', 409);
    flow.view.candidate ??= { ...candidate, id: randomUUID() };
    flow.view.state = 'candidate'; delete flow.view.code;
  }
  private async refreshSafely(flow: Flow) {
    try { this.refresh(flow); }
    catch (error) { await this.cancelFlow(flow, false, cleanupUnknown(error)); throw error instanceof DomainError ? error : new DomainError('target_pairing_cleanup_required', 503); }
  }
  status(id: string): Promise<TelegramTargetPairing> {
    return this.serial(async () => {
      const flow = this.get(id);
      if (terminal(flow.view)) return this.copy(flow);
      if (Date.now() >= Date.parse(flow.view.expires_at)) return this.cancelFlow(flow, true);
      await this.refreshSafely(flow); return this.copy(flow);
    });
  }
  confirm(id: string, candidateId: string): Promise<TelegramTargetPairing> {
    return this.serial(async () => {
      this.checkOpen(); const flow = this.get(id);
      if (flow.view.state === 'completed' && flow.view.candidate?.id === candidateId) return this.copy(flow);
      if (terminal(flow.view)) throw new DomainError('target_pairing_stale', 409);
      if (flow.controller.signal.aborted || Date.now() >= Date.parse(flow.view.expires_at)) { await this.cancelFlow(flow, true); throw new DomainError('target_pairing_stale', 409); }
      await this.refreshSafely(flow);
      const candidate = flow.view.candidate;
      if (!candidate || candidate.id !== candidateId) throw new DomainError('target_pairing_stale', 409);
      try {
        await flow.observer.confirm(candidate.user_id);
      } catch (error) {
        await this.cancelFlow(flow, false, cleanupUnknown(error));
        throw new DomainError(cleanupUnknown(error) ? 'target_pairing_cleanup_required' : 'target_pairing_unavailable', 503);
      }
      try { await flow.observer.close(); }
      catch {
        await this.cancelFlow(flow, false, true);
        throw new DomainError('target_pairing_cleanup_required', 503);
      }
      try {
        this.checkOpen();
        if (flow.controller.signal.aborted || Date.now() >= Date.parse(flow.view.expires_at)) throw new DomainError('target_pairing_stale', 409);
        const snapshot = this.dependencies.configuration();
        const settings = structuredClone(snapshot.settings);
        const previous = settings.targets.find(target => target.channel === 'telegram');
        settings.telegram.enabled = true;
        settings.targets = settings.targets.filter(target => target.channel !== 'telegram');
        settings.targets.push({ id: previous?.id ?? 'telegram-self', channel: 'telegram', account_ref: settings.telegram.account_ref, principal_ref: previous?.principal_ref ?? 'owner', peer_id: candidate.user_id, enabled: true });
        await this.release(flow, true, { expected_revision: snapshot.revision, settings });
        flow.view.state = 'completed';
      } catch (error) { flow.view.state = 'failed'; flow.view.error = error instanceof DomainError ? error.code : 'target_pairing_unavailable'; await this.release(flow, true); throw error; }
      return this.copy(flow);
    });
  }
  private async cancelFlow(flow: Flow, expired: boolean, unsafe = false): Promise<TelegramTargetPairing> {
    if (terminal(flow.view)) return this.copy(flow);
    flow.controller.abort();
    try { await flow.observer.close(); } catch { unsafe = true; }
    flow.view.state = unsafe ? 'failed' : expired ? 'expired' : 'cancelled'; delete flow.view.candidate;
    if (unsafe) flow.view.error = 'target_pairing_cleanup_required';
    try { await this.release(flow, !unsafe); } catch { flow.view.state = 'failed'; flow.view.error = 'target_pairing_cleanup_required'; }
    return this.copy(flow);
  }
  cancel(id: string): Promise<TelegramTargetPairing> {
    if (this.current?.view.id === id) this.current.controller.abort();
    return this.serial(() => this.cancelFlow(this.get(id), false));
  }
  close(): Promise<void> {
    this.closing = true; this.pending?.abort(); this.current?.controller.abort();
    this.closePromise ??= this.serial(async () => { if (this.current && !terminal(this.current.view)) await this.cancelFlow(this.current, false); });
    return this.closePromise;
  }
}
