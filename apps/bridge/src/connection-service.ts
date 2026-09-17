import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ConnectionFlow } from '@voxdock/contracts';
import { authorizeTelegram, TelegramCleanupError, type TelegramAccountConfig } from '../../../packages/telegram/src/account.js';
import { WhatsAppConnection, type WhatsAppConnectionConfig } from './connection-whatsapp.js';

export class ConnectionError extends Error { constructor(message: string, readonly statusCode = 409) { super(message); } }
export interface ConnectionDependencies {
  acquire(): Promise<(safe: boolean) => Promise<void>>;
  getTelegramConfig(): Promise<TelegramAccountConfig>;
  getWhatsAppConfig(): Promise<WhatsAppConnectionConfig>;
  telegramAuthorize?: typeof authorizeTelegram;
  fetch?: typeof fetch;
  ttlMs?: number;
}
type Flow = { cleanupUnknown?: boolean; view: ConnectionFlow; abort: AbortController; release?: (safe: boolean) => Promise<void>; timer?: ReturnType<typeof setTimeout>; pending?: { resolve(value: string): void; reject(error: Error): void }; work?: Promise<void>; wa?: WhatsAppConnection; finishing?: Promise<void> };
const terminal = (flow: Flow) => ['connected', 'cancelled', 'expired', 'failed'].includes(flow.view.state);

export function createConnectionService(dependencies: ConnectionDependencies) {
  let current: Flow | undefined;
  let acquiring = false;
  const ttl = Math.min(300000, Math.max(1000, dependencies.ttlMs ?? 180000));
  function get(id: string): Flow {
    if (!current || current.view.id !== id) throw new ConnectionError('Connection challenge not found', 404);
    return current;
  }
  async function finish(flow: Flow, state: ConnectionFlow['state'], safe: boolean): Promise<void> {
    if (flow.finishing) return flow.finishing;
    flow.view.state = state; delete flow.view.qr; clearTimeout(flow.timer);
    flow.finishing = (async () => {
      const release = flow.release; delete flow.release;
      try { await release?.(safe); } catch { flow.view.state = 'failed'; flow.view.error = 'Connection cleanup requires operator review'; }
    })();
    await flow.finishing;
  }
  async function cancel(id: string, expired = false): Promise<ConnectionFlow> {
    const flow = get(id);
    if (terminal(flow)) return { ...flow.view };
    flow.abort.abort(); flow.pending?.reject(new Error('Cancelled')); delete flow.pending;
    let safe = true;
    try {
      if (flow.wa) await flow.wa.request('disconnect');
      else if (flow.work) await Promise.race([flow.work, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Cleanup timeout')), 10000); timer.unref(); })]);
    } catch { safe = false; }
    safe = safe && !flow.cleanupUnknown;
    if (!safe) flow.view.error = 'Connection cleanup requires operator review';
    await finish(flow, expired ? 'expired' : 'cancelled', safe);
    return { ...flow.view };
  }
  async function begin(channel: ConnectionFlow['channel']): Promise<Flow> {
    if (acquiring || (current && !terminal(current))) throw new ConnectionError('Another connection operation is active');
    acquiring = true;
    try {
      const release = await dependencies.acquire();
      const flow: Flow = { view: { id: randomUUID(), channel, state: 'starting', expires_at: new Date(Date.now() + ttl).toISOString() }, abort: new AbortController(), release };
      current = flow;
      flow.timer = setTimeout(() => { void cancel(flow.view.id, true).catch(() => {}); }, ttl); flow.timer.unref();
      return flow;
    } finally { acquiring = false; }
  }
  function prompt(flow: Flow, state: 'code_required' | 'password_required'): Promise<string> {
    flow.abort.signal.throwIfAborted(); flow.view.state = state;
    return new Promise((resolve, reject) => { flow.pending = { resolve, reject }; });
  }
  return {
    async startTelegram(phone: string): Promise<ConnectionFlow> {
      if (!/^\+[1-9][0-9]{6,14}$/.test(phone)) throw new ConnectionError('An international phone number is required', 400);
      const config = await dependencies.getTelegramConfig();
      let exists = false; try { await access(config.sessionFile); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConnectionError('Telegram session unavailable'); }
      if (exists) throw new ConnectionError('Disconnect the current Telegram account before signing in');
      const flow = await begin('telegram');
      flow.work = (async () => {
        try {
          await mkdir(dirname(config.sessionFile), { recursive: true, mode: 0o700 });
          await chmod(dirname(config.sessionFile), 0o700);
          await (dependencies.telegramAuthorize ?? authorizeTelegram)(config, { phoneNumber: async () => phone, phoneCode: () => prompt(flow, 'code_required'), password: () => prompt(flow, 'password_required') }, flow.abort.signal);
          if (!flow.abort.signal.aborted) await finish(flow, 'connected', true);
        } catch (error) {
          flow.cleanupUnknown = error instanceof TelegramCleanupError;
          if (!flow.abort.signal.aborted) { flow.view.error = 'Telegram sign-in failed'; await finish(flow, 'failed', !flow.cleanupUnknown); }
        }
      })();
      return { ...flow.view };
    },
    async startWhatsApp(): Promise<ConnectionFlow> {
      const config = await dependencies.getWhatsAppConfig();
      const wa = new WhatsAppConnection(config, dependencies.fetch);
      const flow = await begin('whatsapp');
      flow.wa = wa;
      try {
        const result = await flow.wa.request('connect');
        if (flow.abort.signal.aborted || terminal(flow)) return { ...flow.view };
        if (result.paired && result.state === 'open') await finish(flow, 'connected', true);
        else if (result.qr) { flow.view.state = 'qr_required'; flow.view.qr = result.qr; }
      } catch { flow.view.error = 'WhatsApp connection requires operator review'; await finish(flow, 'failed', false); }
      return { ...flow.view };
    },
    async flow(id: string): Promise<ConnectionFlow> {
      const flow = get(id);
      if (!terminal(flow) && flow.wa) {
        try {
          const result = await flow.wa.request('status');
          if (flow.abort.signal.aborted || terminal(flow)) return { ...flow.view };
          if (result.paired && result.state === 'open') await finish(flow, 'connected', true);
          else if (result.qr) { flow.view.state = 'qr_required'; flow.view.qr = result.qr; }
          else { flow.view.state = 'starting'; delete flow.view.qr; }
        } catch { flow.view.error = 'WhatsApp status unavailable'; }
      }
      return { ...flow.view };
    },
    async submit(id: string, field: 'code' | 'password', value: string): Promise<ConnectionFlow> {
      if (!value || value.length > (field === 'code' ? 16 : 256)) throw new ConnectionError('Invalid challenge value', 400);
      const flow = get(id);
      if (Date.now() >= Date.parse(flow.view.expires_at) || flow.view.state !== `${field}_required` || !flow.pending || flow.abort.signal.aborted) throw new ConnectionError('Connection challenge is no longer awaiting this value');
      const pending = flow.pending; delete flow.pending; flow.view.state = 'starting'; pending.resolve(value);
      return { ...flow.view };
    },
    cancel,
    async disconnect(channel: ConnectionFlow['channel']): Promise<{ disconnected: true }> {
      if (acquiring || (current && !terminal(current))) throw new ConnectionError('Cancel the current connection operation first');
      acquiring = true;
      let release: ((safe: boolean) => Promise<void>) | undefined;
      try {
        release = await dependencies.acquire();
        if (channel === 'telegram') {
          const config = await dependencies.getTelegramConfig();
          await unlink(config.sessionFile).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
        } else await new WhatsAppConnection(await dependencies.getWhatsAppConfig(), dependencies.fetch).request('disconnect');
        await release(true); release = undefined;
        return { disconnected: true };
      } catch { await release?.(false); throw new ConnectionError('Disconnect could not be confirmed'); }
      finally { acquiring = false; }
    },
    async close(): Promise<void> { if (current && !terminal(current)) await cancel(current.view.id); },
  };
}
export type ConnectionService = ReturnType<typeof createConnectionService>;
