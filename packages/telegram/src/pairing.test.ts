import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api, TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import bigInt from 'big-integer';
const connection = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('./account.ts', async importOriginal => ({ ...await importOriginal<typeof import('./account.ts')>(), connectTelegram: connection.connect }));
import { TelegramCleanupError } from './account.ts';
import { observeTelegramPairing, type TelegramPairingObserver } from './pairing.ts';
import { hydrateTelegramPeers, persistTelegramPeer } from './peers.ts';

let directory: string;
let observers: TelegramPairingObserver[];
const config = () => ({ apiId: 1, apiHash: 'test-only', sessionFile: join(directory, 'session') });
const user = (id = 2, extra: object = {}) => new Api.User({ id: bigInt(id), accessHash: bigInt(123 + id), firstName: `User ${id}`, ...extra });
const now = 1_800_000_000_000;
const input = (method: 'message' | 'call' = 'message') => ({ method, code: 'test-code', expires_at: new Date(now + 60_000).toISOString() });
function fixture() {
  const handlers = new Map<string, (event: any) => void>();
  const getEntity = vi.fn(async (id: bigInt.BigInteger) => user(Number(id.toString())));
  const invoke = vi.fn(async (_request: unknown) => new Api.Updates({ users: [], chats: [], date: now / 1000, seq: 1, updates: [new Api.UpdatePhoneCall({ phoneCall: new Api.PhoneCallDiscarded({ id: bigInt(10) }) })] }));
  const disconnect = vi.fn(async () => {});
  const client = { getMe: async () => user(1), getEntity, invoke, disconnect, updates: { on: (name: string, handler: (event: any) => void) => { handlers.set(name, handler); return () => handlers.delete(name); } } } as unknown as TelegramClient;
  connection.connect.mockResolvedValue(client);
  const emit = async (kind: string, value: object) => { handlers.get(kind)?.(value); await new Promise(resolve => setImmediate(resolve)); };
  return { handlers, getEntity, invoke, disconnect, emit };
}
async function start(method: 'message' | 'call' = 'message', signal?: AbortSignal) {
  const observer = await observeTelegramPairing(config(), input(method), signal);
  observers.push(observer);
  return observer;
}
const message = (extra: object = {}) => new Api.Message({ id: 1, peerId: new Api.PeerUser({ userId: bigInt(2) }), fromId: new Api.PeerUser({ userId: bigInt(2) }), date: now / 1000, message: 'test-code', ...extra });
const call = (extra: object = {}) => new Api.PhoneCallRequested({ id: bigInt(10), accessHash: bigInt(20), date: now / 1000, adminId: bigInt(2), participantId: bigInt(1), gAHash: Buffer.alloc(32), protocol: new Api.PhoneCallProtocol({ minLayer: 92, maxLayer: 92, libraryVersions: [] }), ...extra });
beforeEach(async () => { vi.resetAllMocks(); vi.spyOn(Date, 'now').mockReturnValue(now); directory = await mkdtemp(join(tmpdir(), 'voxdock-pairing-')); observers = []; });
afterEach(async () => { for (const observer of observers) await observer.close().catch(() => {}); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

test('private exact-code proof freezes first peer; confirmation is explicit and access hashes never leave profile', async () => {
  const f = fixture(); const observer = await start();
  await f.emit('newMessage', { message: message() });
  expect(observer.candidate()).toEqual({ user_id: '2', display_name: 'User 2' });
  expect(await readdir(directory)).toEqual([]);
  await f.emit('newMessage', { message: message({ fromId: new Api.PeerUser({ userId: bigInt(3) }), peerId: new Api.PeerUser({ userId: bigInt(3) }) }) });
  expect(observer.candidate()?.user_id).toBe('2');
  await expect(observer.confirm('3')).rejects.toThrow('mismatch');
  await observer.confirm('2');
  const path = `${config().sessionFile}.peers.json`;
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ account_id: '1', peers: [{ user_id: '2', access_hash: '125' }] });
});

test('rejects outgoing, group, forwarded, stale, self, wrong-code and bot messages', async () => {
  const f = fixture(); const observer = await start();
  for (const extra of [{ out: true }, { peerId: new Api.PeerChat({ chatId: bigInt(3) }) }, { fwdFrom: new Api.MessageFwdHeader({ date: now / 1000 }) }, { date: now / 1000 - 1 }, { fromId: new Api.PeerUser({ userId: bigInt(1) }) }, { message: ' test-code ' }, { viaBotId: bigInt(9) }]) await f.emit('newMessage', { message: message(extra) });
  expect(f.getEntity).not.toHaveBeenCalled();
  f.getEntity.mockResolvedValue(user(2, { bot: true }));
  await f.emit('newMessage', { message: message() });
  expect(observer.candidate()).toBeUndefined();
});

test('call proof requires addressed fresh nonvideo request and matching confirmed discard', async () => {
  const f = fixture(); const observer = await start('call');
  for (const extra of [{ video: true }, { date: now / 1000 - 1 }, { participantId: bigInt(3) }, { adminId: bigInt(1) }]) await f.emit('phoneCall', { phoneCall: call(extra) });
  expect(f.invoke).not.toHaveBeenCalled();
  await f.emit('phoneCall', { phoneCall: call() });
  expect(f.invoke).toHaveBeenCalledOnce();
  const request = f.invoke.mock.calls[0]![0] as unknown as Api.phone.DiscardCall;
  expect(request).toBeInstanceOf(Api.phone.DiscardCall);
  expect(request.reason).toBeInstanceOf(Api.PhoneCallDiscardReasonBusy);
  expect(observer.candidate()?.user_id).toBe('2');
  expect(await readdir(directory)).toEqual([]);
});

test('unconfirmed call hangup exposes cleanup uncertainty and never offers a candidate', async () => {
  const f = fixture(); const observer = await start('call');
  f.invoke.mockResolvedValue(new Api.Updates({ users: [], chats: [], date: 1, seq: 1, updates: [] }));
  await f.emit('phoneCall', { phoneCall: call() });
  expect(() => observer.candidate()).toThrow(TelegramCleanupError);
  await expect(observer.confirm('2')).rejects.toBeInstanceOf(TelegramCleanupError);
  await expect(observer.close()).rejects.toBeInstanceOf(TelegramCleanupError);
  expect(await readdir(directory)).toEqual([]);
});

test('abort removes handlers and prevents in-flight resolution from exposing or persisting a peer', async () => {
  const f = fixture(); const controller = new AbortController(); const observer = await start('message', controller.signal);
  let resolve!: (value: Api.User) => void;
  f.getEntity.mockImplementation(() => new Promise(done => { resolve = done; }));
  await f.emit('newMessage', { message: message() });
  controller.abort(); resolve(user());
  await observer.close();
  expect(f.handlers.size).toBe(0);
  expect(observer.candidate()).toBeUndefined();
  await expect(observer.confirm('2')).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
});

test('expiry blocks confirmation and disconnect failure remains uncertain', async () => {
  const f = fixture(); const observer = await start();
  await f.emit('newMessage', { message: message() });
  vi.mocked(Date.now).mockReturnValue(now + 60_000);
  expect(observer.candidate()).toBeUndefined();
  await expect(observer.confirm('2')).rejects.toThrow();
  f.disconnect.mockRejectedValue(new Error('disconnect failure'));
  await expect(observer.close()).rejects.toBeInstanceOf(TelegramCleanupError);
});

test('confirmed peer survives StringSession restart and preserves previous peers on switching', async () => {
  const path = config().sessionFile;
  persistTelegramPeer(path, '1', user(2), () => {});
  persistTelegramPeer(path, '1', user(3), () => {});
  const session = new StringSession('');
  const client = new TelegramClient(session, 1, 'test-only', { connectionRetries: 0 });
  hydrateTelegramPeers(client, path, '1');
  for (const id of [2, 3]) {
    const peer = await client.getInputEntity(bigInt(id)) as Api.InputPeerUser;
    expect(peer).toBeInstanceOf(Api.InputPeerUser);
    expect(peer.accessHash.toString()).toBe(String(123 + id));
  }
  expect(() => hydrateTelegramPeers(client, path, '4')).toThrow('mismatch');
});

test('cancelled peer-file commit preserves the previous binding and leaves no partial file', async () => {
  const path = config().sessionFile;
  persistTelegramPeer(path, '1', user(2), () => {});
  const previous = await readFile(`${path}.peers.json`, 'utf8');
  expect(() => persistTelegramPeer(path, '1', user(3), () => { throw new Error('cancelled'); })).toThrow('cancelled');
  expect(await readFile(`${path}.peers.json`, 'utf8')).toBe(previous);
  expect(await readdir(directory)).toEqual(['session.peers.json']);
});

test('late observer connection after abort is cleaned and cannot expose an observer', async () => {
  const f = fixture();
  let finish!: (client: TelegramClient) => void;
  const connected = await connection.connect();
  connection.connect.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const result = observeTelegramPairing(config(), input(), controller.signal);
  controller.abort();
  await expect(result).rejects.toBeInstanceOf(TelegramCleanupError);
  finish(connected);
  await new Promise(resolve => setImmediate(resolve));
  expect(f.disconnect).toHaveBeenCalledOnce();
  expect(f.handlers.size).toBe(0);
});

test('TTL automatically removes observations and disconnects', async () => {
  const f = fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const observer = await start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.handlers.size).toBe(0);
    expect(f.disconnect).toHaveBeenCalledOnce();
    await expect(observer.confirm('2')).rejects.toThrow();
  } finally { vi.useRealTimers(); }
});
