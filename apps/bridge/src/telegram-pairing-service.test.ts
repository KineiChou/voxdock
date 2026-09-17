import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseConfig } from '@voxdock/config';
import { CallStore } from '@voxdock/core';
import type { TelegramPairingIdentity } from '@voxdock/contracts';
import { TelegramCleanupError } from '../../../packages/telegram/src/account.js';
import { ConfigurationStore } from './configuration-store.js';
import { RuntimeManager } from './runtime-manager.js';
import { TelegramPairingService, type TelegramPairingObserver } from './telegram-pairing-service.js';
import { createBridgeServer } from './server.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'voxdock-telegram-pairing-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const hash = join(directory, 'hash'); const session = join(directory, 'session');
  writeFileSync(hash, 'synthetic-hash'); writeFileSync(session, 'synthetic-session');
  const baseline = parseConfig({ channels: { telegram: { enabled: true, api_id: 123, api_hash_file: hash, session_file: session, account_ref: 'server-account' }, whatsapp: { enabled: false, account_ref: 'other-account' } },
    targets: [{ id: 'existing-target', channel: 'telegram', account_ref: 'server-account', principal_ref: 'existing-user', peer_id: '101', enabled: true },
      { id: 'other-target', channel: 'whatsapp', account_ref: 'other-account', principal_ref: 'other-user', peer_id: '+15550001001', enabled: false }] });
  const configuration = new ConfigurationStore(baseline, directory, directory); configuration.prepareSessionDirectory();
  const config = configuration.effective(); const store = new CallStore(':memory:'); cleanup.push(() => store.close());
  const factory = vi.fn(async () => ({ readyChannels: new Set<'telegram'>(['telegram']), onCallCreated: vi.fn(), onEnd: vi.fn(), onResult: vi.fn(), close: vi.fn(async () => {}) }));
  const manager = new RuntimeManager(config, store, directory, factory, configuration); await manager.start(); cleanup.push(() => manager.close());
  let candidate: TelegramPairingIdentity | undefined;
  const observer: TelegramPairingObserver = { account: { user_id: '100', display_name: 'Server' }, candidate: vi.fn(() => candidate), confirm: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const observe = vi.fn(async (_config, _input, _signal?: AbortSignal) => observer);
  const service = new TelegramPairingService({ acquire: () => manager.acquire(), configuration: () => configuration.view(), getTelegramConfig: async () => ({ apiId: 123, apiHash: 'synthetic-hash', sessionFile: session }), observe, ttlMs: 1000 });
  cleanup.push(() => service.close());
  return { service, config, configuration, store, manager, factory, observe, observer, setCandidate(value = { user_id: '102', display_name: 'Receiver' }) { candidate = value; } };
}
for (const method of ['message', 'call'] as const) it(`confirms an opaque ${method} candidate and preserves all other configuration`, async () => {
  const f = await fixture(); const original = f.configuration.view().settings;
  expect(await f.service.setup()).toMatchObject({ linked: true, credentials_ready: true, pairing_available: true, target: { user_id: '101' } }); expect(f.observe).not.toHaveBeenCalled();
  const flow = await f.service.start(method);
  if (method === 'message') expect(flow.code).toMatch(/^VOX-[A-F0-9]{12}$/); else expect(flow.code).toBeUndefined();
  expect(f.manager.managing).toBe(true);
  f.setCandidate(); const observed = await f.service.status(flow.id); const candidate = observed.candidate!;
  expect(candidate.id).not.toBe(candidate.user_id); expect((await f.service.status(flow.id)).candidate).toEqual(candidate);
  await expect(f.service.confirm(flow.id, randomUUID())).rejects.toMatchObject({ code: 'target_pairing_stale' }); expect(f.observer.confirm).not.toHaveBeenCalled();
  expect((await f.service.confirm(flow.id, candidate.id)).state).toBe('completed');
  expect(f.observer.confirm).toHaveBeenCalledWith('102'); expect(f.observer.close).toHaveBeenCalled(); expect(f.manager.managing).toBe(false);
  const settings = f.configuration.view().settings;
  expect(settings.targets.find(t => t.channel === 'telegram')).toEqual({ ...original.targets[0], peer_id: '102' });
  expect(settings.targets.find(t => t.channel === 'whatsapp')).toEqual(original.targets[1]);
  expect({ ...settings, targets: [] }).toEqual({ ...original, targets: [] });
});
it('never publishes private peer metadata and rejects self or changing candidates', async () => {
  const f = await fixture(); const flow = await f.service.start('call');
  f.setCandidate({ user_id: '102', display_name: 'Receiver', access_hash: 'private' } as TelegramPairingIdentity);
  const observed = await f.service.status(flow.id); expect(JSON.stringify(observed)).not.toContain('private');
  f.setCandidate({ user_id: '100', display_name: 'Self' });
  await expect(f.service.confirm(flow.id, observed.candidate!.id)).rejects.toMatchObject({ code: 'target_must_differ' });
  expect(f.configuration.view().revision).toBe(0); expect(f.observer.confirm).not.toHaveBeenCalled();
});
it('cancellation and expiration cannot save a late candidate', async () => {
  const f = await fixture(); let flow = await f.service.start('message'); f.setCandidate();
  await f.service.cancel(flow.id); await expect(f.service.confirm(flow.id, randomUUID())).rejects.toMatchObject({ code: 'target_pairing_stale' });
  vi.useFakeTimers(); flow = await f.service.start('call'); await vi.advanceTimersByTimeAsync(1001);
  expect((await f.service.status(flow.id)).state).toBe('expired'); expect(f.configuration.view().revision).toBe(0); expect(f.observer.confirm).not.toHaveBeenCalled();
});
it('aborts a pending connection on expiry without a serialized deadlock', async () => {
  const f = await fixture(); vi.useFakeTimers();
  f.observe.mockImplementationOnce(async (_config, _input, signal) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  const result = f.service.start('call').catch(error => error);
  await vi.advanceTimersByTimeAsync(1001); expect(await result).toMatchObject({ code: 'target_pairing_unavailable' }); expect(f.manager.managing).toBe(false);
});
it('shutdown aborts a pending observer and releases only after its cleanup', async () => {
  const f = await fixture(); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  f.observe.mockImplementationOnce(async (_config, _input, signal) => new Promise((_resolve, reject) => { started(); signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }));
  const result = f.service.start('call').catch(error => error); await ready; await f.service.close(); await result; expect(f.manager.managing).toBe(false);
});
it('uncertain native cleanup leaves the runtime paused and never binds', async () => {
  const f = await fixture(); const flow = await f.service.start('call');
  vi.mocked(f.observer.candidate).mockImplementation(() => { throw new TelegramCleanupError(); });
  await expect(f.service.status(flow.id)).rejects.toMatchObject({ code: 'target_pairing_cleanup_required' });
  expect(f.manager.managing).toBe(true); expect(f.store.isPaused(false)).toBe(true); expect(f.configuration.view().revision).toBe(0);
});
it('runtime apply failure preserves the previous target', async () => {
  const f = await fixture(); const flow = await f.service.start('message'); f.setCandidate(); const view = await f.service.status(flow.id);
  f.factory.mockRejectedValueOnce(new Error('runtime unavailable'));
  await expect(f.service.confirm(flow.id, view.candidate!.id)).rejects.toMatchObject({ code: 'runtime_apply_failed' }); expect(f.configuration.view().revision).toBe(0);
  expect(f.configuration.view().settings.targets[0]!.peer_id).toBe('101');
});
it('requires bearer auth and strict bodies on Telegram pairing routes', async () => {
  const f = await fixture(); const token = 'synthetic-control-token-32-characters-long';
  const app = await createBridgeServer({ config: f.config, store: f.store, controlToken: token, management: f.manager, telegramPairing: f.service }); cleanup.push(() => app.close());
  const prefix = '/v1/console/connections/telegram';
  expect((await app.inject({ method: 'GET', url: `${prefix}/setup` })).statusCode).toBe(401);
  const headers = { authorization: `Bearer ${token}` };
  const setup = await app.inject({ method: 'GET', url: `${prefix}/setup`, headers }); expect(setup.statusCode).toBe(200); expect(setup.headers['cache-control']).toContain('no-store');
  expect((await app.inject({ method: 'POST', url: `${prefix}/target-pairings`, headers, payload: { method: 'call', user_id: '999' } })).statusCode).toBe(400);
  const response = await app.inject({ method: 'POST', url: `${prefix}/target-pairings`, headers, payload: { method: 'call' } }); expect(response.statusCode).toBe(200);
  const id = response.json().id;
  expect((await app.inject({ method: 'POST', url: `${prefix}/target-pairings/${id}/confirm`, headers, payload: { candidate_id: '999' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: `${prefix}/target-pairings/${id}/cancel`, headers, payload: {} })).json().state).toBe('cancelled');
});
it('a failed observer close remains unsafe even if a second close succeeds', async () => {
  const f = await fixture(); const flow = await f.service.start('call'); f.setCandidate(); const view = await f.service.status(flow.id);
  vi.mocked(f.observer.close).mockRejectedValueOnce(new Error('unknown transport cleanup'));
  await expect(f.service.confirm(flow.id, view.candidate!.id)).rejects.toMatchObject({ code: 'target_pairing_cleanup_required' });
  expect(f.manager.managing).toBe(true); expect(f.configuration.view().revision).toBe(0);
});
it('expiration during durable peer persistence never enables the target', async () => {
  const f = await fixture(); vi.useFakeTimers(); const flow = await f.service.start('message'); f.setCandidate(); const view = await f.service.status(flow.id);
  let finish!: () => void; vi.mocked(f.observer.confirm).mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve; }));
  const result = f.service.confirm(flow.id, view.candidate!.id).catch(error => error);
  await vi.advanceTimersByTimeAsync(1001); finish();
  expect(await result).toMatchObject({ code: 'target_pairing_stale' }); expect(f.configuration.view().revision).toBe(0); expect(f.manager.managing).toBe(false);
});
