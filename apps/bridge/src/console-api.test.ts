import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { parseConfig } from '@voxdock/config';
import { CallStore } from '@voxdock/core';
import { createBridgeServer, type BridgeServerOptions } from './server.js';

const token = 'control-test-token-with-at-least-32-characters';
const password = 'console test password';
const salt = '0123456789abcdef0123456789abcdef';
const passwordHash = `scrypt$16384$8$1$${salt}$${scryptSync(password, Buffer.from(salt, 'hex'), 32).toString('hex')}`;
const origin = 'https://console.example.test';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanups.splice(0)) await stop(); vi.useRealTimers(); });
async function setup(extra: Partial<BridgeServerOptions> = {}) {
  const assetsDirectory = mkdtempSync(join(tmpdir(), 'voxdock-console-'));
  writeFileSync(join(assetsDirectory, 'index.html'), '<!doctype html><title>VoxDock</title>');
  const store = new CallStore(':memory:');
  const app = await createBridgeServer({ store, config: parseConfig({}), controlToken: token, console: { passwordHash, publicOrigin: origin, assetsDirectory }, ...extra });
  cleanups.push(async () => { await app.close(); store.close(); rmSync(assetsDirectory, { recursive: true }); });
  const login = async () => {
    const response = await app.inject({ method: 'POST', url: '/admin/v1/session', headers: { origin }, payload: { password } });
    expect(response.statusCode).toBe(200);
    return { cookie: response.cookies.map(cookie => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join('; '), csrf: response.json().csrf_token, response };
  };
  return { app, store, login };
}
it('isolates cookie sessions from bearer control and raw records, revokes logout, and requires same-origin CSRF', async () => {
  const { app, login } = await setup();
  expect((await app.inject('/admin/v1/settings')).statusCode).toBe(401);
  const { cookie, csrf, response } = await login();
  expect(response.headers['set-cookie']).toContain('HttpOnly');
  expect(response.headers['set-cookie']).toContain('Secure');
  expect(response.headers['set-cookie']).toContain('SameSite=Strict');
  expect(response.headers['set-cookie']).toContain('Path=/admin/v1');
  expect(response.body).not.toContain(token);
  expect((await app.inject({ url: '/admin/v1/settings', headers: { cookie } })).statusCode).toBe(200);
  for (const url of ['/v1/calls', '/v1/calls/example/record', '/v1/console/settings']) expect((await app.inject({ url, headers: { cookie } })).statusCode).toBe(401);
  for (const headers of [{ cookie }, { cookie, origin }, { cookie, origin: 'https://evil.example', 'x-csrf-token': csrf }]) {
    expect((await app.inject({ method: 'POST', url: '/admin/v1/control/pause', headers })).statusCode).toBe(403);
  }
  const headers = { cookie, origin, 'x-csrf-token': csrf };
  expect((await app.inject({ method: 'POST', url: '/admin/v1/control/pause', headers })).statusCode).toBe(200);
  expect((await app.inject({ method: 'DELETE', url: '/admin/v1/session', headers })).statusCode).toBe(204);
  expect((await app.inject({ url: '/admin/v1/session', headers: { cookie } })).statusCode).toBe(401);
});
it('rejects login origins, extra fields, malformed cookies and rate limits password attempts', async () => {
  const { app } = await setup();
  expect((await app.inject({ method: 'POST', url: '/admin/v1/session', payload: { password } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/admin/v1/session', headers: { origin }, payload: { password, token } })).statusCode).toBe(400);
  expect((await app.inject({ url: '/admin/v1/settings', headers: { cookie: 'voxdock_session=malformed' } })).statusCode).toBe(401);
  const statuses: number[] = [];
  for (let index = 0; index < 6; index++) statuses.push((await app.inject({ method: 'POST', url: '/admin/v1/session', headers: { origin }, payload: { password: 'incorrect-password' } })).statusCode);
  expect(statuses).toContain(401);
  expect(statuses.at(-1)).toBe(429);
});
it('serves CSP-protected assets and SPA routes without exposing control routes or missing API HTML', async () => {
  const { app, login } = await setup();
  const page = await app.inject('/console/');
  expect(page.statusCode).toBe(200);
  expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect((await app.inject('/console/calls')).statusCode).toBe(200);
  const { cookie } = await login();
  for (const url of ['/admin/v1/missing', '/console/../v1/calls', '/console/%2e%2e/v1/calls', '/v1/missing']) {
    const response = await app.inject({ url, headers: { cookie } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.headers['content-type']).not.toContain('text/html');
  }
});
it('shares settings and control rules with bearer console routes and forwards bounded projection queries', async () => {
  const { app, store, login } = await setup();
  const { cookie, csrf } = await login();
  const admin = await app.inject({ url: '/admin/v1/settings', headers: { cookie } });
  const legacy = await app.inject({ url: '/v1/console/settings', headers: { authorization: `Bearer ${token}` } });
  expect(legacy.json()).toEqual(admin.json());
  expect(admin.body).not.toContain('token_file');
  const headers = { cookie, origin, 'x-csrf-token': csrf };
  expect((await app.inject({ method: 'POST', url: '/admin/v1/control/resume', headers })).json()).toEqual({ error: 'calling_disabled' });
  const spy = vi.spyOn(store, 'consoleCalls');
  const valid = await app.inject({ url: '/admin/v1/calls?limit=20&channel=telegram&direction=outbound', headers: { cookie } });
  expect(valid.statusCode).toBe(200);
  expect(spy).toHaveBeenCalledWith({ limit: 20, channel: 'telegram', direction: 'outbound' });
  for (const query of ['limit=101', 'limit=0', 'secret=yes', 'channel=other']) expect((await app.inject({ url: `/admin/v1/calls?${query}`, headers: { cookie } })).statusCode).toBe(400);
  expect((await app.inject({ url: '/admin/v1/overview?days=30', headers: { cookie } })).statusCode).toBe(200);
});
it('expires authenticated sessions after eight hours', async () => {
  const { app, login } = await setup();
  const { cookie } = await login();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000 + 1000);
  expect((await app.inject({ url: '/admin/v1/session', headers: { cookie } })).statusCode).toBe(401);
});
it('bounds simultaneous expensive password checks', async () => {
  const { app } = await setup();
  const responses = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/admin/v1/session', headers: { origin }, payload: { password } })));
  expect(responses.map(response => response.statusCode).sort()).toEqual([200, 429]);
});

it('keeps recovered uncertain calls visible when the runtime has no active coordinator', async () => {
  const onEnd = vi.fn(async () => {});
  const { app, store, login } = await setup({ onEnd });
  const call = store.createCall('operator', 'recovered', {
    target_id: 'owner', context_ref: 'context', correlation_ref: 'request',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }, { enabled: true, allowedTargets: new Set(['owner']), maxTtlSeconds: 300 }).call;
  store.transition(call.call_id, 'connected', { provider_call_ref: 'provider:recovered' });
  store.recover();
  const { cookie, csrf } = await login();
  for (const [prefix, headers] of [
    ['/admin/v1', { cookie, origin, 'x-csrf-token': csrf }],
    ['/v1', { authorization: `Bearer ${token}` }],
  ] as const) {
    const response = await app.inject({ method: 'POST', url: `${prefix}/calls/${call.call_id}/end`, headers });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'reconciliation_required' });
  }
  expect(onEnd).not.toHaveBeenCalled();
  expect(store.consoleCall(call.call_id).summary).toMatchObject({ can_end: false, call: { state: 'uncertain' } });
  expect(store.consoleOverview({ days: 1, timeZone: 'UTC', dailySeconds: 100 }).attention_calls).toHaveLength(1);
});
