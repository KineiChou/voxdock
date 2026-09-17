import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storage = vi.hoisted(() => ({ afterWrite: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, writeFile: async (...args: Parameters<typeof original.writeFile>) => { await original.writeFile(...args); storage.afterWrite(); } };
});

const sdk = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), qr: vi.fn(), start: vi.fn(), getMe: vi.fn(), save: vi.fn() }));
vi.mock('teleproto', () => ({
  Api: { User: class User { id = 123n; bot = false; } },
  TelegramClient: class {
    connect = sdk.connect;
    disconnect = sdk.disconnect;
    signInUserWithQrCode = sdk.qr;
    start = sdk.start;
    getMe = sdk.getMe;
    session = { save: sdk.save };
    setLogLevel() {}
  },
}));
vi.mock('teleproto/sessions/index.js', () => ({ StringSession: class {} }));
vi.mock('teleproto/extensions/Logger.js', () => ({ LogLevel: { NONE: 'none' } }));
import { Api } from 'teleproto';
import { authorizeTelegram, authorizeTelegramQr, TelegramCleanupError } from './account.ts';

let directory: string;
const config = () => ({ apiId: 1, apiHash: 'test-only', sessionFile: join(directory, 'session') });
const prompts = () => ({ qrCode: vi.fn(async () => {}), password: vi.fn(async () => 'test-password') });
const user = () => new Api.User({ id: 123n as never });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }

beforeEach(async () => {
  vi.resetAllMocks();
  sdk.connect.mockResolvedValue(undefined);
  sdk.disconnect.mockResolvedValue(undefined);
  sdk.qr.mockResolvedValue(user());
  sdk.getMe.mockResolvedValue(user());
  sdk.start.mockResolvedValue(undefined);
  sdk.save.mockReturnValue('test-session');
  directory = await mkdtemp(join(tmpdir(), 'voxdock-telegram-auth-'));
});
afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });

test('delegates repeated QR challenges and two-step password to SDK; persists complete private session', async () => {
  const input = prompts();
  sdk.qr.mockImplementation(async (credentials, callbacks) => {
    expect(credentials).toEqual({ apiId: 1, apiHash: 'test-only' });
    for (const expires of [1_800_000_000, 1_800_000_030]) await callbacks.qrCode({ token: Buffer.from([251, 255]), expires });
    expect(await callbacks.password()).toBe('test-password');
    return user();
  });
  expect(await authorizeTelegramQr(config(), input)).toBe('123');
  expect(input.qrCode.mock.calls).toEqual([
    [{ qr: 'tg://login?token=-_8', expires_at: '2027-01-15T08:00:00.000Z' }],
    [{ qr: 'tg://login?token=-_8', expires_at: '2027-01-15T08:00:30.000Z' }],
  ]);
  expect(input.password).toHaveBeenCalledOnce();
  expect(await readFile(config().sessionFile, 'utf8')).toBe('test-session');
  expect((await stat(config().sessionFile)).mode & 0o777).toBe(0o600);
  expect(await readdir(directory)).toEqual(['session']);
  expect(sdk.disconnect).toHaveBeenCalledOnce();
});

test('phone authorization still persists through the shared exclusive session writer', async () => {
  expect(await authorizeTelegram(config(), { phoneNumber: async () => 'test-phone', phoneCode: async () => 'test-code', password: async () => 'test-password' })).toBe('123');
  expect(await readFile(config().sessionFile, 'utf8')).toBe('test-session');
});

test('cannot overwrite another flow session', async () => {
  await writeFile(config().sessionFile, 'existing');
  await expect(authorizeTelegramQr(config(), prompts())).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(config().sessionFile, 'utf8')).toBe('existing');
  expect(await readdir(directory)).toEqual(['session']);
});

test('abort during password wait blocks late SDK callbacks and session persistence', async () => {
  const controller = new AbortController();
  const passwordStarted = deferred<void>();
  const input = prompts();
  input.password.mockImplementation(() => { passwordStarted.resolve(); return new Promise(() => {}); });
  let callbacks: any;
  sdk.qr.mockImplementation(async (_credentials, value) => { callbacks = value; await value.password(); return user(); });
  const result = authorizeTelegramQr(config(), input, controller.signal);
  await passwordStarted.promise;
  controller.abort();
  await expect(result).rejects.toThrow();
  await expect(callbacks.qrCode({ token: Buffer.from('late'), expires: 1 })).rejects.toThrow();
  await expect(callbacks.password()).rejects.toThrow();
  expect(input.qrCode).not.toHaveBeenCalled();
  expect(input.password).toHaveBeenCalledOnce();
  expect(await readdir(directory)).toEqual([]);
  expect(sdk.disconnect).toHaveBeenCalled();
});

test('abort before starting avoids SDK connections', async () => {
  const signal = AbortSignal.abort();
  await expect(authorizeTelegramQr(config(), prompts(), signal)).rejects.toThrow();
  expect(sdk.connect).not.toHaveBeenCalled();
});

test('abort during an unsettled SDK operation reports uncertain cleanup and cannot later persist', async () => {
  const started = deferred<void>();
  const pending = deferred<Api.User>();
  sdk.qr.mockImplementation(() => { started.resolve(); return pending.promise; });
  const controller = new AbortController();
  const result = authorizeTelegramQr(config(), prompts(), controller.signal);
  await started.promise;
  controller.abort();
  await expect(result).rejects.toBeInstanceOf(TelegramCleanupError);
  pending.resolve(user());
  await new Promise(resolve => setImmediate(resolve));
  expect(await readdir(directory)).toEqual([]);
  expect(sdk.disconnect).toHaveBeenCalledTimes(2);
});

test('disconnect failure prevents session publication', async () => {
  sdk.disconnect.mockRejectedValue(new Error('failed'));
  await expect(authorizeTelegramQr(config(), prompts())).rejects.toBeInstanceOf(TelegramCleanupError);
  expect(await readdir(directory)).toEqual([]);
});

test('abort during disconnect prevents session publication', async () => {
  const controller = new AbortController();
  sdk.disconnect.mockImplementation(async () => controller.abort());
  await expect(authorizeTelegramQr(config(), prompts(), controller.signal)).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
});

test('rejects bot authorization before saving', async () => {
  const bot = user(); bot.bot = true;
  sdk.qr.mockResolvedValue(bot);
  await expect(authorizeTelegramQr(config(), prompts())).rejects.toThrow('user account');
  expect(await readdir(directory)).toEqual([]);
});


test('abort after asynchronous staged write removes the temporary file before the commit boundary', async () => {
  const controller = new AbortController();
  storage.afterWrite.mockImplementation(() => controller.abort());
  await expect(authorizeTelegramQr(config(), prompts(), controller.signal)).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
});

test('disconnect timeout reports uncertain cleanup without publishing credentials', async () => {
  vi.useFakeTimers();
  sdk.disconnect.mockImplementation(() => new Promise(() => {}));
  const result = authorizeTelegramQr(config(), prompts());
  const assertion = expect(result).rejects.toBeInstanceOf(TelegramCleanupError);
  await vi.advanceTimersByTimeAsync(5_000);
  await assertion;
  expect(await readdir(directory)).toEqual([]);
});

test('a connection finishing after cancellation is disconnected without starting authorization', async () => {
  const pending = deferred<void>();
  sdk.connect.mockReturnValue(pending.promise);
  const controller = new AbortController();
  const result = authorizeTelegramQr(config(), prompts(), controller.signal);
  controller.abort();
  await expect(result).rejects.toBeInstanceOf(TelegramCleanupError);
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  expect(sdk.qr).not.toHaveBeenCalled();
  expect(sdk.disconnect).toHaveBeenCalledTimes(2);
  expect(await readdir(directory)).toEqual([]);
});

test('cleanup failure takes precedence over SDK authorization failure', async () => {
  sdk.qr.mockRejectedValue(new Error('authorization failed'));
  sdk.disconnect.mockRejectedValue(new Error('disconnect failed'));
  await expect(authorizeTelegramQr(config(), prompts())).rejects.toBeInstanceOf(TelegramCleanupError);
  expect(await readdir(directory)).toEqual([]);
});
