import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseConfig } from '@voxdock/config';
import { CallStore } from '@voxdock/core';
import { ConfigurationStore } from './configuration-store.js';
import { RuntimeManager } from './runtime-manager.js';
import { TargetPairingService } from './target-pairing-service.js';
import type { WhatsAppPairing } from './connection-whatsapp.js';
import { createBridgeServer } from './server.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'voxdock-target-pairing-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const media = join(directory, 'media-key'); writeFileSync(media, 'synthetic-media-key-32-characters-long', { mode: 0o600 });
  const baseline = parseConfig({ channels: { whatsapp: { enabled: true, endpoint: 'http://wa.test', account_ref: 'server-account', media_token_file: media } },
    targets: [{ id: 'existing-business-target', channel: 'whatsapp', account_ref: 'server-account', principal_ref: 'existing-business-user', peer_id: '+15550001001', enabled: true }] });
  const configuration = new ConfigurationStore(baseline, directory, directory); configuration.prepareSessionDirectory();
  const config = configuration.effective();
  const store = new CallStore(':memory:'); cleanup.push(() => store.close());
  const factory = vi.fn(async () => ({ readyChannels: new Set<'whatsapp'>(['whatsapp']), onCallCreated: vi.fn(), onEnd: vi.fn(), onResult: vi.fn(), close: vi.fn(async () => {}) }));
  const manager = new RuntimeManager(config, store, directory, factory, configuration); await manager.start(); cleanup.push(() => manager.close());
  let observation: WhatsAppPairing | undefined;
  let ownPhone = '+15550001000';
  let failStart = false, failCancel = false;
  let waitStart: Promise<void> | undefined;
  const transport = vi.fn(async (url: URL | RequestInfo, options?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/target-pairing')) {
      await waitStart;
      if (failStart) throw new Error('private upstream payload');
      const input = JSON.parse(String(options?.body)) as { id: string; method: 'message' | 'call'; expires_at: string };
      observation = { id: input.id, method: input.method, expires_at: input.expires_at, state: 'waiting' };
      return Response.json(observation);
    }
    if (path.endsWith('/cancel')) {
      if (failCancel) throw new Error('private upstream payload');
      observation = { ...observation!, state: 'cancelled' }; delete observation.candidate;
      return Response.json(observation);
    }
    if (path.includes('/target-pairing/')) return Response.json(observation);
    return Response.json({ paired: true, state: 'open', phone: ownPhone });
  });
  const service = new TargetPairingService({ acquire: () => manager.acquire(), configuration: () => configuration.view(),
    getWhatsAppConfig: async () => ({ baseUrl: 'http://wa.test', sessionId: 'server-account', clientId: 'voxdock:server-account' }), fetch: transport, ttlMs: 1000 });
  cleanup.push(() => service.close());
  return { service, configuration, config, store, manager, transport, factory,
    candidate(phone = '+15550001002') { const id = randomUUID(); observation = { ...observation!, state: 'candidate', candidate: { id, phone } }; return id; },
    ownPhone(value: string) { ownPhone = value; },
    failStart() { failStart = true; }, failCancel() { failCancel = true; }, waitStart(value: Promise<void>) { waitStart = value; },
  };
}
it('binds only the observed confirmed number and preserves stable business identities', async () => {
  const f = await fixture();
  expect(await f.service.setup()).toMatchObject({ connected: true, account_phone: '+15550001000', target: { phone: '+15550001001' } });
  const flow = await f.service.start('message'); expect(flow.code).toMatch(/^VOX-[A-F0-9]{12}$/);
  expect(f.store.isPaused(false)).toBe(true);
  const id = f.candidate(); expect((await f.service.status(flow.id)).state).toBe('candidate');
  expect(f.configuration.view().revision).toBe(0);
  await expect(f.service.confirm(flow.id, randomUUID())).rejects.toMatchObject({ code: 'target_pairing_stale' });
  const result = await f.service.confirm(flow.id, id); expect(result.state).toBe('completed'); expect(result.code).toBeUndefined();
  expect(f.configuration.view().settings.targets).toEqual([{ id: 'existing-business-target', channel: 'whatsapp', account_ref: 'server-account', principal_ref: 'existing-business-user', peer_id: '+15550001002', enabled: true }]);
  expect(f.store.isPaused(false)).toBe(false); expect(f.manager.managing).toBe(false);
  await f.service.confirm(flow.id, id); expect(f.configuration.view().revision).toBe(1);
  expect(f.transport.mock.calls.every(([url]) => !String(url).includes('/calls'))).toBe(true);
});
it('preserves the target and explicit maintenance on cancellation or expiry', async () => {
  const f = await fixture(); f.store.setPaused(true);
  const first = await f.service.start('call'); f.candidate();
  expect((await f.service.cancel(first.id)).state).toBe('cancelled'); expect(f.configuration.view().revision).toBe(0);
  expect(f.store.isPaused(false)).toBe(true);
  vi.useFakeTimers(); const second = await f.service.start('message'); f.candidate();
  await vi.advanceTimersByTimeAsync(1001);
  expect((await f.service.status(second.id)).state).toBe('expired');
  await expect(f.service.confirm(second.id, randomUUID())).rejects.toMatchObject({ code: 'target_pairing_stale' });
  expect(f.configuration.view().revision).toBe(0); expect(f.manager.managing).toBe(false);
});
it('rejects changed account, own number, and replacement evidence without changing the target', async () => {
  const f = await fixture(); const flow = await f.service.start('call'); const id = f.candidate();
  await f.service.status(flow.id); f.candidate('+15550001003');
  await expect(f.service.confirm(flow.id, id)).rejects.toMatchObject({ code: 'target_pairing_changed' });
  await f.service.cancel(flow.id);
  const second = await f.service.start('message'); const own = f.candidate('+15550001000');
  await expect(f.service.confirm(second.id, own)).rejects.toMatchObject({ code: 'target_must_differ' });
  await f.service.cancel(second.id);
  const third = await f.service.start('call'); const last = f.candidate(); f.ownPhone('+15550001009');
  await expect(f.service.confirm(third.id, last)).rejects.toMatchObject({ code: 'target_pairing_changed' });
  expect(f.configuration.view().revision).toBe(0);
});
it.each(['start', 'cancel'] as const)('holds admission on an unknown observer %s outcome', async action => {
  const f = await fixture();
  if (action === 'start') { f.failStart(); await expect(f.service.start('message')).rejects.toMatchObject({ code: 'target_pairing_cleanup_required' }); }
  else { const flow = await f.service.start('message'); f.failCancel(); expect((await f.service.cancel(flow.id)).error).toBe('target_pairing_cleanup_required'); }
  expect(f.manager.managing).toBe(true); expect(f.store.isPaused(false)).toBe(true);
  expect(f.configuration.view().revision).toBe(0);
});
it('waits for an in-flight arm then cancels before shutdown releases the runtime', async () => {
  const f = await fixture(); let done!: () => void;
  f.waitStart(new Promise(resolve => { done = resolve; }));
  const starting = f.service.start('message');
  await vi.waitFor(() => expect(f.transport.mock.calls.some(([url]) => String(url).endsWith('/target-pairing'))).toBe(true));
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); done();
  expect((await starting).state).toBe('cancelled'); await closing;
  expect(f.manager.managing).toBe(false); expect(f.configuration.view().revision).toBe(0);
});
it.each([true, false])('drains pairing during shutdown without restarting and preserves unsafe cleanup (%s)', async safe => {
  const f = await fixture(); await f.service.start('message');
  if (!safe) f.failCancel();
  f.manager.beginShutdown();
  await f.service.close(); await f.manager.close();
  expect(f.factory).toHaveBeenCalledOnce();
  expect(f.store.isPaused(false)).toBe(!safe);
  expect(f.configuration.view().revision).toBe(0);
});
it('shares authenticated management routes and never accepts a browser-supplied phone as evidence', async () => {
  const f = await fixture();
  const app = await createBridgeServer({ config: f.config, store: f.store, management: f.manager, targetPairing: f.service, controlToken: 'x'.repeat(32) }); cleanup.push(() => app.close());
  const base = '/v1/console/connections/whatsapp'; const headers = { authorization: `Bearer ${'x'.repeat(32)}` };
  expect((await app.inject({ url: `${base}/setup` })).statusCode).toBe(401);
  const start = await app.inject({ method: 'POST', url: `${base}/target-pairings`, headers, payload: { method: 'call' } });
  expect(start.statusCode).toBe(200); expect(start.headers['cache-control']).toBe('no-store'); const id = start.json().id as string;
  const candidate = f.candidate();
  expect((await app.inject({ method: 'POST', url: `${base}/target-pairings/${id}/confirm`, headers, payload: { candidate_id: candidate, phone: '+15550001099' } })).statusCode).toBe(400);
  const confirm = await app.inject({ method: 'POST', url: `${base}/target-pairings/${id}/confirm`, headers, payload: { candidate_id: candidate } });
  expect(confirm.statusCode).toBe(200); expect(confirm.json().state).toBe('completed');
});
