import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { deadline } from './deadline.js';
import type { VoiceDriver, VoiceEvents } from './types.js';

export interface TelegramProcessOptions { apiId: number; apiHashFile: string; sessionFile: string; peerId: string; }
/** Native code and account credentials are owned by a dedicated child, never the HTTP process. */
export async function createTelegramProcess(options: TelegramProcessOptions, callbacks: VoiceEvents): Promise<VoiceDriver> {
  const child = fork(fileURLToPath(new URL('./telegram-worker.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return connectChild(child, options, callbacks);
}
export async function connectChild(child: ChildProcess, options: TelegramProcessOptions, callbacks: VoiceEvents): Promise<VoiceDriver> {
  let closed = false;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const fault = () => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Telegram worker unavailable')); }
    pending.clear(); child.kill('SIGKILL'); callbacks.fault();
  };
  const send = (message: object) => {
    if (closed || !child.connected) throw new Error('Telegram worker unavailable');
    if (!child.send(message, error => { if (error) fault(); })) { fault(); throw new Error('Telegram IPC backpressure'); }
  };
  const request = (operation: string, value: object = {}, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    if (pending.size >= 32) return Promise.reject(new Error('Telegram IPC capacity exceeded'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Telegram worker deadline exceeded')); fault(); }, 15000);
      const abort = () => { try { send({ operation: 'abort', id }); } catch { fault(); } };
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      pending.set(id, { timer, resolve: result => { clean(); resolve(result); }, reject: error => { clean(); reject(error); } });
      signal?.addEventListener('abort', abort, { once: true });
      try { send({ operation, id, ...value }); } catch { pending.delete(id); clean(); reject(new Error('Telegram IPC send failed')); }
    });
  };
  child.on('error', fault); child.on('exit', fault);
  child.on('message', (raw: unknown) => {
    if (closed || !raw || typeof raw !== 'object') return;
    const message = raw as Record<string, unknown>;
    if (typeof message.id === 'string' && message.type === 'response') {
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id);
      if (message.ok === true) item.resolve(message.value); else item.reject(new Error('Telegram worker operation failed'));
      return;
    }
    const ref = typeof message.ref === 'string' && message.ref.length <= 200 ? message.ref : undefined;
    if (message.type === 'state' && ['dialing','ringing','connected','ending','ended','uncertain'].includes(String(message.state))) {
      callbacks.state(ref, message.state as Parameters<VoiceEvents['state']>[1]);
    } else if (message.type === 'audio' && ref && Buffer.isBuffer(message.pcm) && message.pcm.length === 960) callbacks.audio(ref, message.pcm);
    else if (message.type === 'audioReady' && ref) callbacks.audioReady(ref);
    else if (message.type === 'incoming' && ref && typeof message.allowed === 'boolean') callbacks.incoming(ref, message.allowed);
    else if (message.type === 'fault') fault();
    else fault();
  });
  try { await request('init', { options }); } catch { fault(); throw new Error('Telegram worker initialization failed'); }
  return {
    rate: 48000, frameMs: 10,
    async dial(peerId, signal) { const result = await request('dial', { peerId }, signal); if (typeof result !== 'string') throw new Error('Invalid call reference'); return result; },
    async accept(ref, signal) { const result = await request('accept', { ref }, signal); if (typeof result !== 'string') throw new Error('Invalid call reference'); return result; },
    async reject(ref) { await request('reject', { ref }); },
    async end(ref) { await request('end', { ref }); },
    async writeAudio(ref, pcm) { if (pcm.length !== 960) throw new Error('Invalid Telegram frame'); await request('audio', { ref, pcm }); },
    async close() {
      if (closed) return;
      try { await deadline(request('close'), 3000); }
      finally { closed = true; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Telegram worker closed')); } pending.clear(); child.kill('SIGKILL'); }
    },
  };
}
