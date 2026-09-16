import { test, expect, vi } from 'vitest';
import { Api, type TelegramClient } from 'teleproto';
import bigInt from 'big-integer';
const media = vi.hoisted(() => ({ create: vi.fn(async () => {}), connect: vi.fn(async () => {}), close: vi.fn(async () => {}), write: vi.fn(async () => {}),
  native: { initExchange: vi.fn(async (_id: bigint, _config: unknown, _hash: Buffer | null) => Buffer.alloc(32)), exchangeKeys: vi.fn(async () => ({ gAOrB: Buffer.alloc(256), keyFingerprint: 99n })), onSignalingData: vi.fn(), sendSignalingData: vi.fn(async () => {}) } }));
vi.mock('./native.ts', () => ({ TelegramMedia: class { constructor() { return media; } } }));
vi.mock('ntgcalls', () => ({ NTgCalls: { getProtocol: () => ({ minLayer: 92, maxLayer: 92, udpP2p: true, udpReflector: true, libraryVersions: ['13.0.0'] }) } }));
import { TelegramDriver } from './driver.ts';
const protocol = new Api.PhoneCallProtocol({ minLayer: 92, maxLayer: 92, udpP2p: true, udpReflector: true, libraryVersions: ['13.0.0'] });
const common = { id: bigInt(10), accessHash: bigInt(20), date: 1, adminId: bigInt(1), participantId: bigInt(2), protocol };
const waiting = () => new Api.PhoneCallWaiting(common);
const connected = (incoming = false) => new Api.PhoneCall({ ...common, ...(incoming ? { adminId: bigInt(2), participantId: bigInt(1) } : {}), gAOrB: Buffer.alloc(256), keyFingerprint: bigInt(99), connections: [], startDate: 1 });
function fixture() {
  vi.clearAllMocks();
  const handlers = new Map<string, (event: never) => void>();
  const callbacks = { onState: vi.fn(), onAudio: vi.fn(), onAudioReady: vi.fn(), onIncoming: vi.fn() };
  const invoke = vi.fn(async (request: { className: string }) => {
    if (request instanceof Api.messages.GetDhConfig) return new Api.messages.DhConfig({ g: 3, p: Buffer.alloc(256), random: Buffer.alloc(256), version: 1 });
    if (request instanceof Api.phone.RequestCall) return new Api.phone.PhoneCall({ phoneCall: waiting(), users: [] });
    if (request instanceof Api.phone.ConfirmCall) return new Api.phone.PhoneCall({ phoneCall: connected(), users: [] });
    if (request instanceof Api.phone.AcceptCall) return new Api.phone.PhoneCall({ phoneCall: connected(true), users: [] });
    if (request instanceof Api.phone.DiscardCall) return new Api.Updates({ users: [], chats: [], date: 1, seq: 1,
      updates: [new Api.UpdatePhoneCall({ phoneCall: new Api.PhoneCallDiscarded({ id: bigInt(10) }) })] });
    return true;
  });
  const client = { invoke, getMe: async () => new Api.User({ id: bigInt(1) }),
    getInputEntity: async () => new Api.InputPeerUser({ userId: bigInt(2), accessHash: bigInt(3) }),
    updates: { on(name: string, handler: (event: never) => void) { handlers.set(name, handler); return () => handlers.delete(name); } },
  } as unknown as TelegramClient;
  const driver = new TelegramDriver(client, '1', '2', callbacks);
  const update = async (call: Api.TypePhoneCall) => { handlers.get('phoneCall')!({ phoneCall: call } as never); await new Promise(resolve => setImmediate(resolve)); };
  return { driver, callbacks, invoke, update };
}
test('outgoing handshake uses absent hash, confirms once and ends on terminal evidence', async () => {
  const f = fixture();
  expect(await f.driver.dial('2', AbortSignal.timeout(1000))).toBe('10');
  expect(media.native.initExchange.mock.calls[0]?.[2]).toBeNull();
  const accepted = new Api.PhoneCallAccepted({ ...common, gB: Buffer.alloc(256) });
  await f.update(accepted); await f.update(accepted);
  expect(media.native.exchangeKeys).toHaveBeenCalledTimes(1);
  expect(media.connect).toHaveBeenCalledTimes(1);
  expect(f.callbacks.onState).toHaveBeenCalledWith('10', 'connected');
  await f.driver.end('10');
  expect(f.callbacks.onState).toHaveBeenLastCalledWith('10', 'ended');
});
test('incoming notification never answers before admission; foreign caller cannot be accepted', async () => {
  const f = fixture();
  await f.update(new Api.PhoneCallRequested({ ...common, adminId: bigInt(2), participantId: bigInt(1), gAHash: Buffer.alloc(32, 7) }));
  expect(f.callbacks.onIncoming).toHaveBeenCalledWith('10', true);
  expect(f.invoke).not.toHaveBeenCalled();
  await f.driver.accept('10', AbortSignal.timeout(1000));
  expect(media.native.initExchange.mock.calls[0]?.[2]).toEqual(Buffer.alloc(32, 7));
  expect(media.native.exchangeKeys).toHaveBeenCalledWith(2n, Buffer.alloc(256), 99n);
  await f.driver.end('10');
  await f.update(new Api.PhoneCallRequested({ ...common, adminId: bigInt(3), participantId: bigInt(1), gAHash: Buffer.alloc(32) }));
  await expect(f.driver.accept('10', AbortSignal.timeout(1000))).rejects.toThrow('Unapproved');
});
test('lost dial response retains reservation and does not retry', async () => {
  const f = fixture();
  f.invoke.mockImplementation(async request => {
    if (request instanceof Api.messages.GetDhConfig) return new Api.messages.DhConfig({ g: 3, p: Buffer.alloc(256), random: Buffer.alloc(256), version: 1 });
    throw new Error('reply lost');
  });
  await expect(f.driver.dial('2', AbortSignal.timeout(1000))).rejects.toThrow('reconcile');
  await expect(f.driver.dial('2', AbortSignal.timeout(1000))).rejects.toThrow('reserved');
  expect(f.invoke.mock.calls.filter(([r]) => r instanceof Api.phone.RequestCall)).toHaveLength(1);
  expect(f.callbacks.onState).toHaveBeenLastCalledWith(undefined, 'uncertain');
});
