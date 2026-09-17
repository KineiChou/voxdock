import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { parseConfig } from '@voxdock/config';
import { CallStore } from '@voxdock/core';
import { ConfigurationStore } from './configuration-store.js';
import { RuntimeManager } from './runtime-manager.js';
import { unlinkWhatsAppAccount } from './whatsapp-account.js';
import { createConnectionService } from './connection-service.js';
import { TargetPairingService } from './target-pairing-service.js';
import { createBridgeServer } from './server.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'voxdock-unlink-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'media-key'), 'synthetic-media-key-only', { mode: 0o600 });
  const baseline = parseConfig({ channels: { whatsapp: { enabled: true, endpoint: 'http://wa.test', account_ref: 'server-account', media_token_file: 'media-key' } },
    targets: [{ id: 'business-target', channel: 'whatsapp', account_ref: 'server-account', principal_ref: 'user', peer_id: '+15550001001', enabled: true }] });
  const configuration = new ConfigurationStore(baseline, directory, directory); configuration.prepareSessionDirectory();
  const config = configuration.effective(); const store = new CallStore(join(directory, 'state.sqlite')); cleanup.push(() => store.close());
  const factory = vi.fn(async () => ({ readyChannels: new Set<'whatsapp'>(['whatsapp']), onCallCreated: vi.fn(), onEnd: vi.fn(), onResult: vi.fn(), close: vi.fn(async () => {}) }));
  const manager = new RuntimeManager(config, store, directory, factory, configuration); await manager.start(); cleanup.push(() => manager.close());
  const getConfig = async () => ({ baseUrl: 'http://wa.test', sessionId: 'server-account', clientId: 'voxdock:server-account' });
  const history = store.createCall('operator', 'history', { target_id: 'business-target', context_ref: 'past', correlation_ref: 'past', expires_at: new Date(Date.now() + 60000).toISOString() }, { enabled: true, allowedTargets: new Set(['business-target']), maxTtlSeconds: 300 }).call;
  store.transition(history.call_id, 'ended');
  return { directory, baseline, configuration, config, store, factory, manager, getConfig, history };
}
it('durably disables the old binding before logout and retains its identity and history', async () => {
  const f = await fixture();
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, request) => {
    expect(String(url)).toBe('http://wa.test/api/voxdock/sessions/server-account/unlink');
    expect(request?.method).toBe('POST'); expect(request?.body).toBe('{}');
    expect(f.configuration.effective().channels.whatsapp.enabled).toBe(false);
    expect(new ConfigurationStore(f.baseline, f.directory, f.directory).effective().targets[0]!.enabled).toBe(false);
    expect(f.store.isPaused(false)).toBe(true);
    await expect(f.manager.acquire()).rejects.toMatchObject({ code: 'management_busy' });
    return Response.json({ paired: false, state: 'unlinked' });
  });
  expect(await unlinkWhatsAppAccount(f.manager, f.getConfig, fetch)).toEqual({ unlinked: true });
  expect(fetch).toHaveBeenCalledOnce(); expect(f.store.isPaused(false)).toBe(false);
  expect(f.configuration.view().settings.targets[0]).toEqual({ ...f.baseline.targets[0], enabled: false });
  expect(f.store.getCall(f.history.call_id).state).toBe('ended');
});
it.each(['timeout', 'still_paired'])('retains disabled bindings and a durable recovery pause on %s', async reason => {
  const f = await fixture();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (reason === 'timeout') throw new Error('private provider details');
    return Response.json({ paired: true, state: 'disconnected' });
  });
  await expect(unlinkWhatsAppAccount(f.manager, f.getConfig, fetch)).rejects.toMatchObject({ code: 'whatsapp_unlink_unconfirmed' });
  expect(f.configuration.view().revision).toBe(1); expect(f.manager.managing).toBe(true);
  const reopened = new CallStore(join(f.directory, 'state.sqlite'));
  try { expect(reopened.isPaused(false)).toBe(true); } finally { reopened.close(); }
  expect(new ConfigurationStore(f.baseline, f.directory, f.directory).effective().channels.whatsapp.enabled).toBe(false);
  expect(f.store.listCalls()).toHaveLength(1);
});
it('does not contact the account when candidate runtime installation fails', async () => {
  const f = await fixture(); f.factory.mockRejectedValueOnce(new Error('runtime unavailable'));
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(unlinkWhatsAppAccount(f.manager, f.getConfig, fetch)).rejects.toMatchObject({ code: 'runtime_apply_failed' });
  expect(fetch).not.toHaveBeenCalled(); expect(f.configuration.view().revision).toBe(0);
  expect(f.config.channels.whatsapp.enabled).toBe(true); expect(f.store.isPaused(false)).toBe(false);
});
it('rejects unlink while the call ledger is occupied', async () => {
  const f = await fixture();
  f.store.createCall('operator', 'active', { target_id: 'business-target', context_ref: 'active', correlation_ref: 'active', expires_at: new Date(Date.now() + 60000).toISOString() }, { enabled: true, allowedTargets: new Set(['business-target']), maxTtlSeconds: 300 });
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(unlinkWhatsAppAccount(f.manager, f.getConfig, fetch)).rejects.toMatchObject({ code: 'active_or_uncertain_call' });
  expect(fetch).not.toHaveBeenCalled(); expect(f.configuration.view().revision).toBe(0);
});
it('drains logout before shutdown closes the installed runtime', async () => {
  const f = await fixture(); let done!: () => void;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { await new Promise<void>(resolve => { done = resolve; }); return Response.json({ paired: false, state: 'unlinked' }); });
  const unlink = unlinkWhatsAppAccount(f.manager, f.getConfig, fetch);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  let closed = false; const closing = f.manager.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  done(); await Promise.all([unlink, closing]); expect(closed).toBe(true);
  expect(f.configuration.view().settings.whatsapp.enabled).toBe(false);
});
it('exposes a strict authenticated API and reports offline and incomplete unlink states independently', async () => {
  const f = await fixture();
  let session: { paired: boolean; state: string; phone?: string } = { paired: true, state: 'disconnected', phone: '+15550001000' };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => Response.json(String(url).endsWith('/unlink') ? { paired: false, state: 'unlinked' } : session));
  const connections = createConnectionService({ acquire: () => f.manager.acquire(), getWhatsAppConfig: f.getConfig, getTelegramConfig: async () => { throw new Error('unused'); }, unlinkWhatsApp: () => unlinkWhatsAppAccount(f.manager, f.getConfig, fetch) });
  const pairing = new TargetPairingService({ acquire: () => f.manager.acquire(), configuration: () => f.configuration.view(), getWhatsAppConfig: f.getConfig, fetch }); cleanup.push(() => pairing.close());
  expect(await pairing.setup()).toMatchObject({ linked: true, connected: false, account_phone: '+15550001000', pairing_available: false });
  session = { paired: false, state: 'unlink_recovery_required' };
  expect(await pairing.setup()).toMatchObject({ linked: false, connected: false, unlink_pending: true, pairing_available: false });
  const app = await createBridgeServer({ config: f.config, store: f.store, management: f.manager, connections, controlToken: 'x'.repeat(32) }); cleanup.push(() => app.close());
  const url = '/v1/console/connections/whatsapp/unlink'; const headers = { authorization: `Bearer ${'x'.repeat(32)}` };
  expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url, headers, payload: { account_ref: 'other-account' } })).statusCode).toBe(400);
  const response = await app.inject({ method: 'POST', url, headers, payload: {} });
  expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ unlinked: true }); expect(response.headers['cache-control']).toBe('no-store');
});
