import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TelegramCleanupError } from '../../../packages/telegram/src/account.js';
import { createConnectionService, type ConnectionDependencies } from './connection-service.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(authorize: NonNullable<ConnectionDependencies['telegramAuthorizeQr']>, ttlMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'voxdock-telegram-qr-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const release = vi.fn(async (_safe: boolean) => {});
  const acquire = vi.fn(async () => release);
  const config = { apiId: 1, apiHash: 'synthetic-private-hash', sessionFile: join(directory, 'session') };
  const service = createConnectionService({ acquire, getTelegramConfig: async () => config,
    getWhatsAppConfig: async () => { throw new Error('Not used'); }, telegramAuthorizeQr: authorize, ...(ttlMs ? { ttlMs } : {}) });
  cleanups.push(() => service.close());
  return { service, config, acquire, release };
}
function aborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => { signal!.throwIfAborted(); signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); });
}
const challenge = (token: string, milliseconds = 30_000) => ({ qr: `tg://login?token=${token}`, expires_at: new Date(Date.now() + milliseconds).toISOString() });

it('rotates tokens within one lease and removes them after cancellation, including late callbacks', async () => {
  let publish!: (value: ReturnType<typeof challenge>) => Promise<void>;
  const { service, acquire, release } = await fixture(async (_, prompts, signal) => {
    publish = prompts.qrCode; await publish(challenge('first')); return aborted(signal);
  });
  const flow = await service.startTelegramQr();
  await vi.waitFor(async () => expect((await service.flow(flow.id)).qr).toContain('first'));
  await expect(service.startTelegramQr()).rejects.toThrow('connection_operation_active');
  await publish(challenge('second'));
  expect((await service.flow(flow.id)).qr).toContain('second');
  await expect(service.submit(flow.id, 'code', '12345')).rejects.toThrow('connection_challenge_stale');
  const cancelled = await service.cancel(flow.id);
  expect(cancelled).toMatchObject({ state: 'cancelled' }); expect(cancelled.qr).toBeUndefined();
  await publish(challenge('late'));
  expect((await service.flow(flow.id)).state).toBe('cancelled');
  expect((await service.flow(flow.id)).qr).toBeUndefined();
  expect(acquire).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it('clears QR on two-step authentication and ignores token refreshes while the password is checked', async () => {
  let askPassword!: () => Promise<string>;
  let publish!: (value: ReturnType<typeof challenge>) => Promise<void>;
  let complete!: () => void;
  const { service, release } = await fixture(async (_, prompts) => {
    publish = prompts.qrCode; askPassword = prompts.password;
    await publish(challenge('scan'));
    await new Promise<void>(resolve => { complete = resolve; });
    return '100';
  });
  const flow = await service.startTelegramQr();
  await vi.waitFor(async () => expect((await service.flow(flow.id)).state).toBe('qr_required'));
  const password = askPassword();
  expect((await service.flow(flow.id)).qr).toBeUndefined();
  expect((await service.flow(flow.id)).state).toBe('password_required');
  await publish(challenge('late-before-password'));
  expect((await service.flow(flow.id)).state).toBe('password_required');
  await service.submit(flow.id, 'password', 'synthetic-two-step-secret');
  expect(await password).toBe('synthetic-two-step-secret');
  await publish(challenge('late-after-password'));
  expect((await service.flow(flow.id)).state).toBe('starting');
  complete();
  await vi.waitFor(async () => expect((await service.flow(flow.id)).state).toBe('connected'));
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
  expect(JSON.stringify(await service.flow(flow.id))).not.toMatch(/token=|synthetic-two-step-secret/);
});

it('hides an expired token and caps future tokens at the overall flow deadline', async () => {
  let publish!: (value: ReturnType<typeof challenge>) => Promise<void>;
  const { service } = await fixture(async (_, prompts, signal) => {
    publish = prompts.qrCode; await publish(challenge('short', 100)); return aborted(signal);
  });
  const flow = await service.startTelegramQr();
  await vi.waitFor(async () => expect((await service.flow(flow.id)).state).toBe('qr_required'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 200);
  expect((await service.flow(flow.id)).qr).toBeUndefined();
  await publish(challenge('long', 600_000));
  expect((await service.flow(flow.id)).qr_expires_at).toBe(flow.expires_at);
  await publish({ qr: 'tg://login?token=invalid-expiry', expires_at: 'invalid' });
  expect((await service.flow(flow.id)).qr).toBeUndefined();
});

it('expires the whole flow without letting SDK rotation extend its deadline', async () => {
  const { service, release } = await fixture(async (_, prompts, signal) => {
    await prompts.qrCode(challenge('scan')); return aborted(signal);
  }, 1000);
  const flow = await service.startTelegramQr();
  await vi.waitFor(async () => expect((await service.flow(flow.id)).state).toBe('qr_required'));
  await vi.waitFor(async () => expect((await service.flow(flow.id)).state).toBe('expired'), { timeout: 2000 });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
  expect((await service.flow(flow.id)).qr).toBeUndefined();
});

it('keeps admission blocked when Telegram cleanup cannot be confirmed', async () => {
  const { service, release } = await fixture(async (_, prompts, signal) => {
    await prompts.qrCode(challenge('scan'));
    try { return await aborted(signal); } finally { throw new TelegramCleanupError(); }
  });
  const flow = await service.startTelegramQr();
  await vi.waitFor(async () => expect((await service.flow(flow.id)).state).toBe('qr_required'));
  expect(await service.cancel(flow.id)).toMatchObject({ state: 'cancelled', error: 'connection_cleanup_required' });
  expect(release).toHaveBeenCalledExactlyOnceWith(false);
});

it('does not invoke authorization or replace an existing Telegram session', async () => {
  const authorize = vi.fn<NonNullable<ConnectionDependencies['telegramAuthorizeQr']>>();
  const { service, config, release } = await fixture(authorize);
  await writeFile(config.sessionFile, 'existing-private-session', { mode: 0o600 });
  await expect(service.startTelegramQr()).rejects.toThrow('telegram_already_connected');
  expect(authorize).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it('removes account-bound peer credentials together with an explicitly disconnected session', async () => {
  const { service, config, release } = await fixture(vi.fn());
  for (const path of [config.sessionFile, `${config.sessionFile}.peers.json`]) await writeFile(path, 'synthetic-private-data', { mode: 0o600 });
  expect(await service.disconnect('telegram')).toEqual({ disconnected: true });
  for (const path of [config.sessionFile, `${config.sessionFile}.peers.json`]) await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
