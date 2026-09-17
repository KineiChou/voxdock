import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseConfig } from '@voxdock/config';
import { CallStore } from '@voxdock/core';
import { ConfigurationStore } from './configuration-store.js';
import { RuntimeManager } from './runtime-manager.js';
import type { RuntimeFactory } from './cli-service.js';
import { createBridgeServer } from './server.js';
import { openConsoleAccount } from './console-account.js';
import { hashConsolePassword } from './console-password.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function setup(factory?: RuntimeFactory) {
  const directory = mkdtempSync(join(tmpdir(), 'console-configuration-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const baseline = parseConfig({ service: { data_dir: directory } });
  const configuration = new ConfigurationStore(baseline, directory, directory);
  configuration.prepareSessionDirectory();
  const store = new CallStore(join(directory, 'state.sqlite')); cleanups.push(() => store.close());
  const config = configuration.effective();
  const start = factory ?? vi.fn(async () => ({ readyChannels: new Set<'telegram'>(), onCallCreated: vi.fn(), onEnd: vi.fn(), onResult: vi.fn(), close: vi.fn(async () => {}) }));
  const manager = new RuntimeManager(config, store, directory, start, configuration);
  cleanups.push(() => manager.close());
  return { directory, baseline, configuration, store, config, manager, start };
}
it('persists applied settings and private secret references; rejects stale revisions and preserves deployment fields', async () => {
  const f = setup(); await f.manager.start();
  const input = { expected_revision: 0, settings: f.configuration.view().settings, secrets: { live_api_key: 'synthetic-live-key' } };
  input.settings.live.voice = 'cedar';
  const result = await f.manager.apply(input);
  expect(result).toMatchObject({ revision: 1, settings: { live: { voice: 'cedar' } }, credentials: { live_api_key: true } });
  expect(f.store.isPaused(false)).toBe(false);
  expect(JSON.stringify(result)).not.toContain('synthetic-live-key');
  expect(readFileSync(join(f.directory, 'managed-configuration.json'), 'utf8')).not.toContain('synthetic-live-key');
  expect(statSync(f.config.live.api_key_file!).mode & 0o777).toBe(0o600);
  expect(new ConfigurationStore(f.baseline, f.directory, f.directory).effective().live.voice).toBe('cedar');
  await expect(f.manager.apply(input)).rejects.toMatchObject({ code: 'revision_conflict' });
});
it('rejects changes during active or uncertain calls and serializes pairing with settings and resume', async () => {
  const f = setup(); await f.manager.start();
  const input = { expected_revision: 0, settings: f.configuration.view().settings };
  const id = f.store.createCall('operator', 'busy', { target_id: 'owner', context_ref: 'ctx', correlation_ref: 'ref', expires_at: new Date(Date.now() + 60000).toISOString() }, { enabled: true, allowedTargets: new Set(['owner']), maxTtlSeconds: 300 }).call.call_id;
  await expect(f.manager.apply(input)).rejects.toMatchObject({ code: 'active_or_uncertain_call' });
  f.store.transition(id, 'uncertain');
  await expect(f.manager.acquire()).rejects.toMatchObject({ code: 'active_or_uncertain_call' });
  f.store.transition(id, 'ended');
  const release = await f.manager.acquire();
  await expect(f.manager.apply(input)).rejects.toMatchObject({ code: 'management_busy' });
  const app = await createBridgeServer({ config: f.config, store: f.store, management: f.manager, controlToken: 'x'.repeat(32) });
  try { expect((await app.inject({ method: 'POST', url: '/v1/control/resume', headers: { authorization: `Bearer ${'x'.repeat(32)}` } })).json()).toEqual({ error: 'management_busy' }); }
  finally { await app.close(); }
  await release(true); expect(f.manager.managing).toBe(false); expect(f.store.isPaused(false)).toBe(false);
});
it('rolls back failed runtime creation without committing new settings', async () => {
  let count = 0;
  const f = setup(async () => { if (++count === 2) throw new Error('unavailable'); return { readyChannels: new Set(), onCallCreated: async () => {}, onEnd: async () => {}, onResult: async () => {}, close: async () => {} }; });
  await f.manager.start();
  const settings = f.configuration.view().settings; settings.live.voice = 'cedar';
  await expect(f.manager.apply({ expected_revision: 0, settings })).rejects.toMatchObject({ code: 'runtime_apply_failed' });
  expect(f.configuration.view().revision).toBe(0); expect(f.config.live.voice).toBe('marin'); expect(count).toBe(3);
  expect(f.store.isPaused(false)).toBe(false);
});
it('keeps admission locked when runtime shutdown cannot be confirmed', async () => {
  let fail = true, starts = 0;
  const f = setup(async () => { starts++; return { readyChannels: new Set(), onCallCreated: async () => {}, onEnd: async () => {}, onResult: async () => {}, close: async () => { if (fail) throw new Error('unknown'); } }; });
  await f.manager.start();
  await expect(f.manager.apply({ expected_revision: 0, settings: f.configuration.view().settings })).rejects.toMatchObject({ code: 'runtime_stop_failed' });
  expect(f.manager.managing).toBe(true); expect(starts).toBe(1);
  const reopened = new CallStore(join(f.directory, 'state.sqlite'));
  try { expect(reopened.isPaused(false)).toBe(true); } finally { reopened.close(); }
  fail = false;
});
it('does not restart the prior runtime if a failed commit also has an uncertain candidate shutdown', async () => {
  let starts = 0, fail = true;
  const f = setup(async () => {
    const number = ++starts;
    return { readyChannels: new Set(), onCallCreated: async () => {}, onEnd: async () => {}, onResult: async () => {}, close: async () => { if (number === 2 && fail) throw new Error('cleanup_unknown'); } };
  });
  await f.manager.start();
  const prepare = f.configuration.prepare.bind(f.configuration);
  vi.spyOn(f.configuration, 'prepare').mockImplementation(input => ({ ...prepare(input), commit: () => { throw new Error('disk_unavailable'); } }));
  await expect(f.manager.apply({ expected_revision: 0, settings: f.configuration.view().settings })).rejects.toMatchObject({ code: 'runtime_stop_failed' });
  expect(starts).toBe(2); expect(f.manager.managing).toBe(true); expect(f.configuration.view().revision).toBe(0);
  fail = false;
});
it('waits for an unfinished runtime start and closes its result during shutdown', async () => {
  let complete!: () => void;
  const closed = vi.fn(async () => {});
  const f = setup(async () => { await new Promise<void>(resolve => { complete = resolve; }); return { readyChannels: new Set(), onCallCreated: async () => {}, onEnd: async () => {}, onResult: async () => {}, close: closed }; });
  const started = f.manager.start();
  let done = false;
  const closing = f.manager.close().then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  complete(); await Promise.all([started, closing]); expect(closed).toHaveBeenCalledOnce();
});
it('does not restore a disconnected imported Telegram session on restart', () => {
  const f = setup();
  const original = join(f.directory, 'original.session'); writeFileSync(original, 'synthetic-session');
  f.baseline.channels.telegram.session_file = original;
  unlinkSync(join(f.configuration.secretsDirectory, 'telegram-session-imported'));
  f.configuration.prepareSessionDirectory(); expect(readFileSync(f.configuration.telegramSession, 'utf8')).toBe('synthetic-session');
  unlinkSync(f.configuration.telegramSession);
  new ConfigurationStore(f.baseline, f.directory, f.directory).prepareSessionDirectory();
  expect(() => readFileSync(f.configuration.telegramSession)).toThrow();
});
it('enforces remote management restrictions on cookie and bearer APIs while retaining audit access', async () => {
  const f = setup(); writeFileSync(join(f.directory, 'index.html'), '<html></html>');
  const account = await openConsoleAccount({ dataDirectory: f.directory, legacyPasswordHash: await hashConsolePassword('synthetic-password') });
  await account.recover({ allow_remote_management: false });
  const app = await createBridgeServer({ config: f.config, store: f.store, controlToken: 'x'.repeat(32), management: f.manager, console: { account, publicOrigin: 'https://console.example', assetsDirectory: f.directory, trustedProxyAddresses: ['10.1.0.2'] } });
  try {
    for (const path of ['/v1/console/settings/configuration', '/v1/console/connections', '/console/settings', '/admin/v1/account']) expect((await app.inject({ url: path, remoteAddress: '10.1.0.2', headers: { authorization: `Bearer ${'x'.repeat(32)}`, 'x-forwarded-for': '203.0.113.1' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/v1/console/settings/configuration', remoteAddress: '203.0.113.1', headers: { authorization: `Bearer ${'x'.repeat(32)}`, 'x-forwarded-for': '127.0.0.1' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/v1/console/calls', remoteAddress: '203.0.113.1', headers: { authorization: `Bearer ${'x'.repeat(32)}` } })).statusCode).toBe(200);
  } finally { await app.close(); }
});

it('commits verified settings under the pairing lease and restores admission', async () => {
  const f = setup(); await f.manager.start();
  const release = await f.manager.acquire();
  const settings = f.configuration.view().settings; settings.live.voice = 'cedar';
  settings.records.transcript_retention_days = 7;
  const capture = vi.spyOn(f.store, 'setTranscriptCapture');
  await release(true, { expected_revision: 0, settings });
  expect(f.configuration.view().revision).toBe(1);
  expect(f.config.live.voice).toBe('cedar');
  expect(capture).toHaveBeenCalledWith(true);
  expect(f.manager.managing).toBe(false);
  expect(f.store.isPaused(false)).toBe(false);
});
it('restores the prior runtime and preserves stale revision errors on lease release', async () => {
  const f = setup(); await f.manager.start();
  const release = await f.manager.acquire();
  await expect(release(true, { expected_revision: 1, settings: f.configuration.view().settings })).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(f.start).toHaveBeenCalledTimes(2);
  expect(f.configuration.view().revision).toBe(0);
  expect(f.manager.managing).toBe(false);
});
it('rolls back a failed lease candidate without committing settings', async () => {
  let starts = 0;
  const f = setup(async () => {
    if (++starts === 2) throw new Error('unavailable');
    return { readyChannels: new Set(), onCallCreated: async () => {}, onEnd: async () => {}, onResult: async () => {}, close: async () => {} };
  });
  await f.manager.start(); const release = await f.manager.acquire();
  await expect(release(true, { expected_revision: 0, settings: f.configuration.view().settings })).rejects.toMatchObject({ code: 'runtime_apply_failed' });
  expect(starts).toBe(3); expect(f.configuration.view().revision).toBe(0); expect(f.manager.managing).toBe(false);
});
it('ignores updates from an unsafe lease release and retains exclusivity', async () => {
  const f = setup(); await f.manager.start(); const release = await f.manager.acquire();
  await release(false, { expected_revision: 0, settings: f.configuration.view().settings });
  await release(true);
  const reopened = new CallStore(join(f.directory, 'state.sqlite'));
  try { expect(reopened.isPaused(false)).toBe(true); } finally { reopened.close(); }
  expect(f.start).toHaveBeenCalledOnce(); expect(f.manager.managing).toBe(true); expect(f.configuration.view().revision).toBe(0);
});
it('waits for lease commit shutdown, closes late candidates, and shares repeated release promises', async () => {
  let complete!: () => void, starts = 0;
  const candidateClosed = vi.fn(async () => {});
  const f = setup(async () => {
    const number = ++starts;
    if (number === 2) await new Promise<void>(resolve => { complete = resolve; });
    return { readyChannels: new Set(), onCallCreated: async () => {}, onEnd: async () => {}, onResult: async () => {}, close: number === 2 ? candidateClosed : async () => {} };
  });
  await f.manager.start(); const release = await f.manager.acquire();
  const releasing = release(true, { expected_revision: 0, settings: f.configuration.view().settings });
  expect(release(true)).toBe(releasing);
  const rejected = expect(releasing).rejects.toMatchObject({ code: 'service_closing' });
  let done = false; const closing = f.manager.close().then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  complete(); await Promise.all([rejected, closing]);
  expect(candidateClosed).toHaveBeenCalledOnce(); expect(starts).toBe(2); expect(f.configuration.view().revision).toBe(0);
});
it('keeps a lease candidate owned when commit and cleanup both fail', async () => {
  let starts = 0, fail = true;
  const f = setup(async () => {
    const number = ++starts;
    return { readyChannels: new Set(), onCallCreated: async () => {}, onEnd: async () => {}, onResult: async () => {}, close: async () => { if (number === 2 && fail) throw new Error('unknown'); } };
  });
  await f.manager.start(); const release = await f.manager.acquire();
  const prepare = f.configuration.prepare.bind(f.configuration);
  vi.spyOn(f.configuration, 'prepare').mockImplementation(input => ({ ...prepare(input), commit: () => { throw new Error('disk_unavailable'); } }));
  await expect(release(true, { expected_revision: 0, settings: f.configuration.view().settings })).rejects.toMatchObject({ code: 'runtime_stop_failed' });
  expect(starts).toBe(2); expect(f.manager.managing).toBe(true); expect(f.configuration.view().revision).toBe(0);
  fail = false;
});
it('waits for lease acquisition shutdown and never exposes a lease after closing', async () => {
  let complete!: () => void;
  const stopped = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  const f = setup(async () => ({ readyChannels: new Set(), onCallCreated: async () => {}, onEnd: async () => {}, onResult: async () => {}, close: stopped }));
  await f.manager.start();
  const acquiring = f.manager.acquire();
  const rejected = expect(acquiring).rejects.toMatchObject({ code: 'service_closing' });
  await expect(f.manager.acquire()).rejects.toMatchObject({ code: 'management_busy' });
  let done = false; const closing = f.manager.close().then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  complete(); await Promise.all([rejected, closing]); expect(stopped).toHaveBeenCalledOnce();
});
it('does not restart or commit a lease released after shutdown', async () => {
  const f = setup(); await f.manager.start(); const release = await f.manager.acquire();
  await f.manager.close();
  await expect(release(true, { expected_revision: 0, settings: f.configuration.view().settings })).rejects.toMatchObject({ code: 'service_closing' });
  expect(f.start).toHaveBeenCalledOnce(); expect(f.configuration.view().revision).toBe(0);
});
it('blocks admission only during management and preserves explicit maintenance pause', async () => {
  const f = setup(); await f.manager.start();
  const release = await f.manager.acquire();
  expect(f.store.isPaused(false)).toBe(true);
  const reopened = new CallStore(join(f.directory, 'state.sqlite'));
  try { expect(reopened.isPaused(false)).toBe(false); } finally { reopened.close(); }
  await release(true);
  expect(f.store.isPaused(false)).toBe(false);
  f.store.setPaused(true);
  await f.manager.apply({ expected_revision: 0, settings: f.configuration.view().settings });
  expect(f.store.isPaused(false)).toBe(true);
  const maintenanceRelease = await f.manager.acquire(); await maintenanceRelease(true);
  expect(f.store.isPaused(false)).toBe(true);
});
it('rejects an unsafe late release without writing recovery state after shutdown', async () => {
  const f = setup(); await f.manager.start(); const release = await f.manager.acquire();
  await f.manager.close(); const paused = vi.spyOn(f.store, 'setPaused');
  await expect(release(false)).rejects.toMatchObject({ code: 'service_closing' });
  expect(paused).not.toHaveBeenCalled();
});
