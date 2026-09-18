import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { expect, test, vi } from 'vitest';
import { connectChild } from './telegram-process.js';

test('Telegram worker forwards only the media failure code on uncertain events', async () => {
  const child = Object.assign(new EventEmitter(), { connected: true, kill: vi.fn(), send: vi.fn((message: { id: string }) => {
    queueMicrotask(() => child.emit('message', { type: 'response', id: message.id, ok: true }));
    return true;
  }) });
  const callbacks = { state: vi.fn(), audio: vi.fn(), audioReady: vi.fn(), incoming: vi.fn(), fault: vi.fn() };
  const driver = await connectChild(child as unknown as ChildProcess, { apiId: 1, apiHashFile: 'test-only', sessionFile: 'test-only', peerId: '2' }, callbacks);
  try {
    child.emit('message', { type: 'state', ref: '10', state: 'uncertain', reason: 'telegram_media_connect_failed' });
    child.emit('message', { type: 'state', ref: '10', state: 'uncertain', reason: 'raw untrusted details' });
    child.emit('message', { type: 'state', ref: '10', state: 'connected', reason: 'telegram_media_connect_failed' });
    expect(callbacks.state.mock.calls).toEqual([
      ['10', 'uncertain', 'telegram_media_connect_failed'], ['10', 'uncertain', undefined], ['10', 'connected', undefined],
    ]);
    expect(callbacks.fault).not.toHaveBeenCalled();
  } finally { await driver.close(); }
});
