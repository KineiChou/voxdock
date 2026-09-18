import { readFile } from 'node:fs/promises';
import { connectTelegram, telegramAccountProfile, TelegramDriver } from '@voxdock/telegram';
import type { TelegramProcessOptions } from './telegram-process.js';
let driver: TelegramDriver | undefined;
let disconnect: (() => Promise<unknown>) | undefined;
let initializing = false;
let activeController: AbortController | undefined;
let pending = 0;
function emit(event: object): void {
  if (!process.connected || !process.send) return;
  if (!process.send(event, (error: Error | null) => { if (error) process.exit(1); })) process.exit(1);
}
process.on('uncaughtException', () => { emit({ type: 'fault' }); process.exit(1); });
process.on('unhandledRejection', () => { emit({ type: 'fault' }); process.exit(1); });
process.on('disconnect', () => process.exit(1));
process.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as Record<string, unknown>;
  if (typeof message.id !== 'string' || message.id.length > 100 || typeof message.operation !== 'string') return;
  if (message.operation === 'abort') { activeController?.abort(); return; }
  if (++pending > 32) { emit({ type: 'fault' }); process.exit(1); }
  const id = message.id;
  void (async () => {
    let result: unknown;
    if (message.operation === 'init') {
      if (driver || initializing) throw new Error('Already initialized');
      initializing = true;
      const options = message.options as TelegramProcessOptions;
      if (!options || !Number.isSafeInteger(options.apiId) || typeof options.apiHashFile !== 'string' || typeof options.sessionFile !== 'string' || typeof options.peerId !== 'string') throw new Error('Invalid account setup');
      const client = await connectTelegram({ apiId: options.apiId, apiHash: (await readFile(options.apiHashFile, 'utf8')).trim(), sessionFile: options.sessionFile });
      disconnect = () => client.disconnect();
      const profile = await telegramAccountProfile(client);
      driver = new TelegramDriver(client, profile.userId, options.peerId, {
        onState: (ref, state, reason) => emit({ type: 'state', ref, state, ...(reason ? { reason } : {}) }),
        onAudio: (ref, pcm) => emit({ type: 'audio', ref, pcm }),
        onAudioReady: ref => emit({ type: 'audioReady', ref }),
        onIncoming: (ref, allowed) => emit({ type: 'incoming', ref, allowed }),
      });
    } else {
      if (!driver) throw new Error('Worker not initialized');
      if (message.operation === 'dial' || message.operation === 'accept') {
        activeController = new AbortController();
        if (message.operation === 'dial' && typeof message.peerId === 'string') result = await driver.dial(message.peerId, activeController.signal);
        else if (message.operation === 'accept' && typeof message.ref === 'string') result = await driver.accept(message.ref, activeController.signal);
        else throw new Error('Invalid call command');
      } else if (message.operation === 'close') { await driver.close(); await disconnect?.(); }
      else if (typeof message.ref !== 'string' || message.ref.length > 200) throw new Error('Invalid call reference');
      else if (message.operation === 'end') await driver.end(message.ref);
      else if (message.operation === 'reject') await driver.reject(message.ref);
      else if (message.operation === 'audio' && Buffer.isBuffer(message.pcm) && message.pcm.length === 960) await driver.writeAudio(message.ref, message.pcm);
      else throw new Error('Unknown worker command');
    }
    emit({ type: 'response', id, ok: true, value: result });
  })().catch(() => emit({ type: 'response', id, ok: false })).finally(() => pending--);
});
