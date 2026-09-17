import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ConnectionFlow } from '@voxdock/contracts';
import { authorizeTelegram, authorizeTelegramQr, TelegramCleanupError, type TelegramAccountConfig } from '../../../packages/telegram/src/account.js';
import { WhatsAppConnection, type WhatsAppConnectionConfig, type WhatsAppSession } from './connection-whatsapp.js';

export class ConnectionError extends Error { constructor(message: string, readonly statusCode = 409) { super(message); } }
export interface ConnectionDependencies {
  acquire(): Promise<(safe: boolean) => Promise<void>>;
  getTelegramConfig(): Promise<TelegramAccountConfig>;
  getWhatsAppConfig(): Promise<WhatsAppConnectionConfig>;
  unlinkWhatsApp?(): Promise<{ unlinked: true }>;
  telegramAuthorize?: typeof authorizeTelegram;
  telegramAuthorizeQr?: typeof authorizeTelegramQr;
  fetch?: typeof fetch;
  ttlMs?: number;
}
type Flow = { generation: number; connecting?: boolean; canceling?: Promise<ConnectionFlow>; cleanupUnknown?: boolean; view: ConnectionFlow; abort: AbortController; release?: (safe: boolean) => Promise<void>; timer?: ReturnType<typeof setTimeout>; pending?: { resolve(value: string): void; reject(error: Error): void }; work?: Promise<void>; wa?: WhatsAppConnection; finishing?: Promise<void> };
const terminal = (flow: Flow) => ['connected', 'cancelled', 'expired', 'failed'].includes(flow.view.state);
function clearQr(flow: Flow): void { delete flow.view.qr; delete flow.view.qr_expires_at; }

export function createConnectionService(dependencies: ConnectionDependencies) {
  let current: Flow | undefined;
  let acquiring = false;
  const ttl = Math.min(300000, Math.max(1000, dependencies.ttlMs ?? 180000));
  function get(id: string): Flow {
    if (!current || current.view.id !== id) throw new ConnectionError('connection_challenge_not_found', 404);
    return current;
  }
  async function finish(flow: Flow, state: ConnectionFlow['state'], safe: boolean): Promise<void> {
    if (flow.finishing) return flow.finishing;
    flow.view.state = state; clearQr(flow); clearTimeout(flow.timer);
    flow.finishing = (async () => {
      const release = flow.release; delete flow.release;
      try { await release?.(safe); } catch { flow.view.state = 'failed'; flow.view.error = 'connection_cleanup_required'; }
    })();
    await flow.finishing;
  }
  async function cancel(id: string, expired = false): Promise<ConnectionFlow> {
    const flow = get(id);
    if (terminal(flow)) return { ...flow.view };
    if (flow.canceling) return flow.canceling;
    flow.canceling = (async () => {
    flow.abort.abort(); flow.generation++; clearQr(flow); flow.pending?.reject(new Error('Cancelled')); delete flow.pending;
    let safe = true;
    try {
      if (flow.wa) {
        await flow.work;
        if (flow.cleanupUnknown) throw new Error('Connect outcome unknown');
        await flow.wa.request('disconnect');
      }
      else if (flow.work) await Promise.race([flow.work, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Cleanup timeout')), 10000); timer.unref(); })]);
    } catch { safe = false; }
    safe = safe && !flow.cleanupUnknown;
    if (!safe) flow.view.error = 'connection_cleanup_required';
    await finish(flow, expired ? 'expired' : 'cancelled', safe);
    return { ...flow.view };
    })();
    return flow.canceling;
  }
  async function begin(channel: ConnectionFlow['channel']): Promise<Flow> {
    if (acquiring || (current && !terminal(current))) throw new ConnectionError('connection_operation_active');
    acquiring = true;
    try {
      const release = await dependencies.acquire();
      const flow: Flow = { generation: 0, view: { id: randomUUID(), channel, state: 'starting', expires_at: new Date(Date.now() + ttl).toISOString() }, abort: new AbortController(), release };
      current = flow;
      flow.timer = setTimeout(() => { void cancel(flow.view.id, true).catch(() => {}); }, ttl); flow.timer.unref();
      return flow;
    } finally { acquiring = false; }
  }
  function prompt(flow: Flow, state: 'code_required' | 'password_required'): Promise<string> {
    flow.abort.signal.throwIfAborted(); clearQr(flow); flow.view.state = state;
    return new Promise((resolve, reject) => { flow.pending = { resolve, reject }; });
  }
  async function startTelegram(method: { phone: string } | { qr: true }): Promise<ConnectionFlow> {
    const flow = await begin('telegram');
    let config: TelegramAccountConfig;
    try {
      config = await dependencies.getTelegramConfig();
      let exists = false; try { await access(config.sessionFile); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConnectionError('telegram_session_unavailable'); }
      if (exists) throw new ConnectionError('telegram_already_connected');
    } catch (error) { await finish(flow, 'failed', true); throw error; }
    let scanning = 'qr' in method;
    flow.work = (async () => {
      try {
        await mkdir(dirname(config.sessionFile), { recursive: true, mode: 0o700 });
        await chmod(dirname(config.sessionFile), 0o700);
        flow.abort.signal.throwIfAborted();
        const password = () => { scanning = false; return prompt(flow, 'password_required'); };
        if ('phone' in method) {
          await (dependencies.telegramAuthorize ?? authorizeTelegram)(config, { phoneNumber: async () => method.phone, phoneCode: () => prompt(flow, 'code_required'), password }, flow.abort.signal);
        } else {
          await (dependencies.telegramAuthorizeQr ?? authorizeTelegramQr)(config, {
            password,
            async qrCode(challenge) {
              // The SDK may complete an in-flight token refresh after scanning or cancellation.
              if (!scanning || flow.abort.signal.aborted || terminal(flow)) return;
              const expiry = Math.min(Date.parse(challenge.expires_at), Date.parse(flow.view.expires_at));
              clearQr(flow);
              if (!Number.isFinite(expiry) || expiry <= Date.now()) { flow.view.state = 'starting'; return; }
              flow.view.state = 'qr_required'; flow.view.qr = challenge.qr;
              flow.view.qr_expires_at = new Date(expiry).toISOString();
            },
          }, flow.abort.signal);
        }
        scanning = false;
        if (!flow.abort.signal.aborted) await finish(flow, 'connected', true);
      } catch (error) {
        scanning = false;
        flow.cleanupUnknown = error instanceof TelegramCleanupError;
        if (!flow.abort.signal.aborted) { flow.view.error = flow.cleanupUnknown ? 'connection_cleanup_required' : 'telegram_sign_in_failed'; await finish(flow, 'failed', !flow.cleanupUnknown); }
      }
    })();
    return { ...flow.view };
  }
  async function applyWhatsAppStatus(flow: Flow, result: WhatsAppSession): Promise<void> {
    if (flow.abort.signal.aborted || terminal(flow)) return;
    clearQr(flow); delete flow.view.error;
    if (result.paired && result.state === 'open') { await finish(flow, 'connected', true); return; }
    const failures: Record<string, string> = { qr_expired: 'whatsapp_qr_expired', pairing_failed: 'whatsapp_pairing_failed', client_outdated: 'whatsapp_client_outdated', pairing_interrupted: 'whatsapp_pairing_interrupted', pairing_recovery_required: 'connection_cleanup_required', unlink_recovery_required: 'connection_cleanup_required' };
    const error = failures[result.state];
    if (error) {
      flow.view.error = error;
      let safe = error !== 'connection_cleanup_required';
      if (safe) { try { await flow.wa!.request('disconnect'); } catch { safe = false; } }
      if (flow.abort.signal.aborted) return;
      if (!safe) { flow.cleanupUnknown = true; flow.view.error = 'connection_cleanup_required'; }
      await finish(flow, result.state === 'qr_expired' ? 'expired' : 'failed', safe);
    } else if (result.qr && result.state === 'qr' && (!result.qr_expires_at || Date.parse(result.qr_expires_at) > Date.now())) {
      flow.view.state = 'qr_required'; flow.view.qr = result.qr;
      if (result.qr_expires_at) flow.view.qr_expires_at = result.qr_expires_at;
    } else flow.view.state = 'starting';
  }
  function requestWhatsApp(flow: Flow, action: 'connect' | 'refresh'): void {
    flow.connecting = true; flow.generation++;
    flow.view.state = 'starting'; clearQr(flow); delete flow.view.error;
    flow.work = (async () => {
      try { await applyWhatsAppStatus(flow, await flow.wa!.request(action)); }
      catch {
        flow.cleanupUnknown = true; flow.view.error = 'connection_cleanup_required';
        if (!flow.abort.signal.aborted) await finish(flow, 'failed', false);
      } finally { flow.connecting = false; }
    })();
  }
  return {
    async accountStatus(): Promise<{ telegram: boolean; whatsapp: boolean }> {
      const [telegram, whatsapp] = await Promise.all([
        dependencies.getTelegramConfig().then(config => access(config.sessionFile).then(() => true)).catch(() => false),
        dependencies.getWhatsAppConfig().then(config => new WhatsAppConnection(config, dependencies.fetch).request('status')).then(session => session.paired && session.state === 'open').catch(() => false),
      ]);
      return { telegram, whatsapp };
    },
    async startTelegram(phone: string): Promise<ConnectionFlow> {
      if (!/^\+[1-9][0-9]{6,14}$/.test(phone)) throw new ConnectionError('invalid_phone_number', 400);
      return startTelegram({ phone });
    },
    startTelegramQr: () => startTelegram({ qr: true }),
    async startWhatsApp(): Promise<ConnectionFlow> {
      const flow = await begin('whatsapp');
      let wa: WhatsAppConnection;
      try { wa = new WhatsAppConnection(await dependencies.getWhatsAppConfig(), dependencies.fetch); }
      catch (error) { await finish(flow, 'failed', true); throw error; }
      flow.wa = wa;
      requestWhatsApp(flow, 'connect');
      return { ...flow.view };
    },
    async refreshWhatsApp(id: string): Promise<ConnectionFlow> {
      const flow = get(id);
      if (flow.view.channel !== 'whatsapp' || !flow.wa) throw new ConnectionError('connection_challenge_stale');
      if (flow.view.state === 'connected') return { ...flow.view };
      if (terminal(flow) || flow.abort.signal.aborted || Date.now() >= Date.parse(flow.view.expires_at)) throw new ConnectionError('connection_challenge_stale');
      if (flow.connecting) throw new ConnectionError('connection_operation_active');
      clearTimeout(flow.timer);
      flow.view.expires_at = new Date(Date.now() + ttl).toISOString();
      flow.timer = setTimeout(() => { void cancel(flow.view.id, true).catch(() => {}); }, ttl); flow.timer.unref();
      requestWhatsApp(flow, 'refresh');
      return { ...flow.view };
    },
    async flow(id: string): Promise<ConnectionFlow> {
      const flow = get(id);
      if (!terminal(flow) && !flow.connecting && flow.wa) {
        const generation = flow.generation;
        try {
          const result = await flow.wa.request('status');
          if (flow.abort.signal.aborted || terminal(flow) || flow.connecting || generation !== flow.generation) return { ...flow.view };
          flow.connecting = true;
          flow.work = applyWhatsAppStatus(flow, result).finally(() => { flow.connecting = false; });
          await flow.work;
        } catch {
          if (!flow.abort.signal.aborted && !terminal(flow) && !flow.connecting && generation === flow.generation) { clearQr(flow); flow.view.state = 'starting'; flow.view.error = 'whatsapp_status_unavailable'; }
        }
      }
      if (flow.view.qr_expires_at && Date.parse(flow.view.qr_expires_at) <= Date.now()) { clearQr(flow); flow.view.state = 'starting'; }
      return { ...flow.view };
    },
    async submit(id: string, field: 'code' | 'password', value: string): Promise<ConnectionFlow> {
      if (!value || value.length > (field === 'code' ? 16 : 256)) throw new ConnectionError('invalid_challenge_value', 400);
      const flow = get(id);
      if (Date.now() >= Date.parse(flow.view.expires_at) || flow.view.state !== `${field}_required` || !flow.pending || flow.abort.signal.aborted) throw new ConnectionError('connection_challenge_stale');
      const pending = flow.pending; delete flow.pending; clearQr(flow); flow.view.state = 'starting'; pending.resolve(value);
      return { ...flow.view };
    },
    cancel,
    async unlinkWhatsApp(): Promise<{ unlinked: true }> {
      if (acquiring || (current && !terminal(current))) throw new ConnectionError('connection_operation_active');
      if (!dependencies.unlinkWhatsApp) throw new ConnectionError('whatsapp_unlink_unavailable', 503);
      acquiring = true;
      try { return await dependencies.unlinkWhatsApp(); }
      finally { acquiring = false; }
    },
    async disconnect(channel: ConnectionFlow['channel']): Promise<{ disconnected: true }> {
      if (acquiring || (current && !terminal(current))) throw new ConnectionError('connection_operation_active');
      acquiring = true;
      let release: ((safe: boolean) => Promise<void>) | undefined;
      try {
        release = await dependencies.acquire();
        if (channel === 'telegram') {
          const config = await dependencies.getTelegramConfig();
          await unlink(`${config.sessionFile}.peers.json`).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
          await unlink(config.sessionFile).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
        } else await new WhatsAppConnection(await dependencies.getWhatsAppConfig(), dependencies.fetch).request('disconnect');
        await release(true); release = undefined;
        return { disconnected: true };
      } catch { await release?.(false); throw new ConnectionError('connection_disconnect_unconfirmed'); }
      finally { acquiring = false; }
    },
    async close(): Promise<void> {
      const flow = current;
      if (flow && !terminal(flow)) await cancel(flow.view.id);
      await flow?.canceling;
      await flow?.finishing;
    },
  };
}
export type ConnectionService = ReturnType<typeof createConnectionService>;
