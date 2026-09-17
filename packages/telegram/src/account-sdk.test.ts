import { afterEach, expect, test, vi } from 'vitest';
import type { TelegramClient as Client } from 'teleproto';
import { MTProtoSender } from 'teleproto/network/MTProtoSender.js';

const captured = vi.hoisted(() => ({ client: undefined as Client | undefined }));
vi.mock('teleproto', async importOriginal => {
  const actual = await importOriginal<typeof import('teleproto')>();
  return { ...actual, TelegramClient: class extends actual.TelegramClient {
    constructor(...args: ConstructorParameters<typeof actual.TelegramClient>) { super(...args); captured.client = this; }
  } };
});
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), readFile: vi.fn(async () => '') }));
import { Api } from 'teleproto';
import { connectTelegram } from './account.ts';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); captured.client = undefined; });

test('production runtime client performs one real SDK connect attempt and one RPC attempt without replay', async () => {
  vi.useFakeTimers();
  // Keep the pinned SDK's constructor, connect retry loop, and invoke policy loop.
  // Replace only transport work so no socket or account is ever contacted.
  const dial = vi.spyOn(MTProtoSender.prototype, '_connect').mockRejectedValue(new Error('test transport unavailable'));
  const opening = expect(connectTelegram({ apiId: 1, apiHash: 'test-only', sessionFile: '/unused-test-only' })).rejects.toThrow();
  await vi.runAllTimersAsync();
  await opening;
  expect(dial).toHaveBeenCalledTimes(1);

  const client = captured.client!;
  const sender = client._sender!;
  // The transport failure closed this sender. Supply the minimal live-sender
  // view for invoke while retaining its real request-attempt loop and policy.
  vi.spyOn(sender, 'userDisconnected', 'get').mockReturnValue(false);
  client._connectedDeferred.resolve();
  const enqueue = vi.spyOn(sender, 'addStateToQueue').mockImplementation(state => {
    state.reject({ errorMessage: 'RPC_CALL_FAIL' });
  });
  const request = expect(client.invoke(new Api.updates.GetState())).rejects.toThrow('Request was unsuccessful 1 time(s)');
  await vi.runAllTimersAsync();
  await request;
  expect(enqueue).toHaveBeenCalledTimes(1);
});
