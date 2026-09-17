import { randomBytes, randomUUID } from 'node:crypto';
import type { ConsoleConfigurationUpdate, ConsoleConfigurationView, TargetPairing, WhatsAppSetup } from '@voxdock/contracts';
import { DomainError } from '@voxdock/core';
import { WhatsAppConnection, type WhatsAppConnectionConfig, type WhatsAppPairing } from './connection-whatsapp.js';

export type PairingRelease = (safe: boolean, update?: ConsoleConfigurationUpdate) => Promise<void>;
export interface TargetPairingDependencies {
  acquire(): Promise<PairingRelease>;
  configuration(): ConsoleConfigurationView;
  getWhatsAppConfig(): Promise<WhatsAppConnectionConfig>;
  fetch?: typeof fetch;
  ttlMs?: number;
}
interface Flow {
  view: TargetPairing;
  wa: WhatsAppConnection;
  snapshot: ConsoleConfigurationView;
  release: PairingRelease;
  timer: ReturnType<typeof setTimeout>;
  released: boolean;
}
const terminal = (view: TargetPairing) => ['completed', 'cancelled', 'expired', 'failed'].includes(view.state);
function phoneLabel(value: string): string | null {
  const match = /^(?:\+?([1-9][0-9]{6,14})|([1-9][0-9]{6,14})(?::[0-9]+)?@s\.whatsapp\.net)$/.exec(value);
  return match ? `+${match[1] ?? match[2]}` : null;
}

/** One temporary observer owns the stopped runtime until confirmation or cleanup. */
export class TargetPairingService {
  private current: Flow | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private readonly ttl: number;
  constructor(private readonly dependencies: TargetPairingDependencies) {
    this.ttl = Math.min(180000, Math.max(1000, dependencies.ttlMs ?? 180000));
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  private checkOpen(): void { if (this.closing) throw new DomainError('service_closing', 503); }
  private get(id: string): Flow {
    if (!this.current || this.current.view.id !== id) throw new DomainError('target_pairing_not_found', 404);
    return this.current;
  }
  private copy(flow: Flow): TargetPairing { return structuredClone(flow.view); }
  private async release(flow: Flow, safe: boolean, update?: ConsoleConfigurationUpdate): Promise<void> {
    if (flow.released) return;
    flow.released = true;
    clearTimeout(flow.timer);
    delete flow.view.code;
    await flow.release(safe, update);
  }
  async setup(): Promise<WhatsAppSetup> {
    const snapshot = this.dependencies.configuration();
    const target = snapshot.settings.targets.find(target => target.channel === 'whatsapp');
    const targetPhone = target ? phoneLabel(target.peer_id) : null;
    const result: WhatsAppSetup = { available: snapshot.deployment.whatsapp_available, linked: false, unlink_pending: false, connected: false, account_phone: null,
      target: target && targetPhone ? { phone: targetPhone, enabled: target.enabled } : null, pairing_available: false };
    if (!result.available) return result;
    try {
      const wa = new WhatsAppConnection(await this.dependencies.getWhatsAppConfig(), this.dependencies.fetch);
      const session = await wa.request('status');
      result.linked = session.paired;
      result.unlink_pending = session.state === 'unlink_recovery_required';
      result.connected = session.paired && session.state === 'open';
      result.account_phone = result.linked ? session.phone ?? null : null;
      result.pairing_available = result.connected && result.account_phone !== null;
    } catch { /* Status reads never reset or reconnect an account. */ }
    return result;
  }
  start(method: TargetPairing['method']): Promise<TargetPairing> {
    return this.serial(async () => {
      this.checkOpen();
      if (!['message', 'call'].includes(method)) throw new DomainError('invalid_pairing_method', 400);
      if (this.current && !terminal(this.current.view)) throw new DomainError('target_pairing_active', 409);
      const release = await this.dependencies.acquire();
      let armed = false;
      let flow: Flow | undefined;
      try {
        this.checkOpen();
        const snapshot = this.dependencies.configuration();
        if (!snapshot.deployment.whatsapp_available) throw new DomainError('whatsapp_service_required', 409);
        const wa = new WhatsAppConnection(await this.dependencies.getWhatsAppConfig(), this.dependencies.fetch);
        const session = await wa.request('status');
        if (!session.paired || session.state !== 'open' || !session.phone) throw new DomainError('whatsapp_account_required', 409);
        const id = randomUUID();
        const view: TargetPairing = { id, method, state: 'waiting', expires_at: new Date(Date.now() + this.ttl).toISOString(), account_phone: session.phone,
          ...(method === 'message' ? { code: `VOX-${randomBytes(6).toString('hex').toUpperCase()}` } : {}) };
        const timer = setTimeout(() => { void this.serial(async () => { if (this.current?.view.id === id && !terminal(this.current.view)) await this.cancelFlow(this.current, true); }).catch(() => {}); }, this.ttl);
        timer.unref();
        flow = { view, wa, snapshot, release, timer, released: false };
        this.current = flow;
        armed = true;
        const observed = await wa.pairing('start', id, { method, expires_at: view.expires_at, ...(view.code ? { code: view.code } : {}) });
        if (this.closing || Date.now() >= Date.parse(view.expires_at)) return this.cancelFlow(flow, !this.closing);
        this.observe(flow, observed);
        return this.copy(flow);
      } catch (error) {
        if (flow) {
          flow.view.state = 'failed'; flow.view.error = 'target_pairing_cleanup_required';
          // A late request may still arm the observer. Do not release ownership on an unknown result.
          await this.release(flow, !armed).catch(() => {});
        } else await release(true);
        if (!armed && error instanceof DomainError) throw error;
        throw new DomainError(armed ? 'target_pairing_cleanup_required' : 'target_pairing_unavailable', 503);
      }
    });
  }
  private observe(flow: Flow, observed: WhatsAppPairing): void {
    if (observed.method !== flow.view.method || Date.parse(observed.expires_at) !== Date.parse(flow.view.expires_at)) throw new DomainError('target_pairing_changed', 409);
    if (observed.state === 'candidate' && observed.candidate) {
      if (observed.candidate.phone === flow.view.account_phone) throw new DomainError('target_must_differ', 409);
      if (flow.view.candidate && (flow.view.candidate.id !== observed.candidate.id || flow.view.candidate.phone !== observed.candidate.phone)) throw new DomainError('target_pairing_changed', 409);
      flow.view.state = 'candidate'; flow.view.candidate = { ...observed.candidate }; delete flow.view.code;
    } else if (observed.state !== 'waiting' || flow.view.state === 'candidate') throw new DomainError('target_pairing_stale', 409);
    delete flow.view.error;
  }
  private async refresh(flow: Flow): Promise<void> {
    const observed = await flow.wa.pairing('status', flow.view.id);
    this.observe(flow, observed);
  }
  status(id: string): Promise<TargetPairing> {
    return this.serial(async () => {
      const flow = this.get(id);
      if (terminal(flow.view)) return this.copy(flow);
      if (Date.now() >= Date.parse(flow.view.expires_at)) return this.cancelFlow(flow, true);
      try { await this.refresh(flow); }
      catch { flow.view.error = 'target_pairing_unavailable'; }
      return this.copy(flow);
    });
  }
  confirm(id: string, candidateId: string): Promise<TargetPairing> {
    return this.serial(async () => {
      this.checkOpen();
      const flow = this.get(id);
      if (flow.view.state === 'completed' && flow.view.candidate?.id === candidateId) return this.copy(flow);
      if (terminal(flow.view)) throw new DomainError('target_pairing_stale', 409);
      if (Date.now() >= Date.parse(flow.view.expires_at)) { await this.cancelFlow(flow, true); throw new DomainError('target_pairing_stale', 409); }
      await this.refresh(flow);
      const candidate = flow.view.candidate;
      if (flow.view.state !== 'candidate' || !candidate || candidate.id !== candidateId) throw new DomainError('target_pairing_stale', 409);
      const session = await flow.wa.request('status');
      if (!session.paired || session.state !== 'open' || session.phone !== flow.view.account_phone) throw new DomainError('target_pairing_changed', 409);
      if (Date.now() >= Date.parse(flow.view.expires_at)) { await this.cancelFlow(flow, true); throw new DomainError('target_pairing_stale', 409); }
      try {
        await flow.wa.pairing('cancel', id);
      } catch {
        flow.view.state = 'failed'; flow.view.error = 'target_pairing_cleanup_required';
        await this.release(flow, false);
        throw new DomainError('target_pairing_cleanup_required', 503);
      }
      const settings = structuredClone(flow.snapshot.settings);
      const previous = settings.targets.find(target => target.channel === 'whatsapp');
      settings.whatsapp.enabled = true;
      settings.targets = settings.targets.filter(target => target.channel !== 'whatsapp');
      settings.targets.push({ id: previous?.id ?? 'whatsapp-self', channel: 'whatsapp', account_ref: settings.whatsapp.account_ref,
        principal_ref: previous?.principal_ref ?? 'owner', peer_id: candidate.phone, enabled: true });
      try {
        this.checkOpen();
        if (Date.now() >= Date.parse(flow.view.expires_at)) throw new DomainError('target_pairing_stale', 409);
        await this.release(flow, true, { expected_revision: flow.snapshot.revision, settings });
        flow.view.state = 'completed'; delete flow.view.error;
      } catch (error) {
        flow.view.state = 'failed'; flow.view.error = error instanceof DomainError ? error.code : 'target_pairing_unavailable';
        await this.release(flow, true);
        throw error;
      }
      return this.copy(flow);
    });
  }
  private async cancelFlow(flow: Flow, expired: boolean): Promise<TargetPairing> {
    if (terminal(flow.view)) return this.copy(flow);
    let safe = true;
    try { await flow.wa.pairing('cancel', flow.view.id); }
    catch { safe = false; }
    flow.view.state = safe ? expired ? 'expired' : 'cancelled' : 'failed';
    delete flow.view.candidate;
    if (!safe) flow.view.error = 'target_pairing_cleanup_required';
    try { await this.release(flow, safe); }
    catch { flow.view.state = 'failed'; flow.view.error = 'target_pairing_cleanup_required'; }
    return this.copy(flow);
  }
  cancel(id: string): Promise<TargetPairing> { return this.serial(() => this.cancelFlow(this.get(id), false)); }
  close(): Promise<void> {
    this.closing = true;
    this.closePromise ??= this.serial(async () => { if (this.current && !terminal(this.current.view)) await this.cancelFlow(this.current, false); });
    return this.closePromise;
  }
}
