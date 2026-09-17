import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { openConsoleAccount } from './console-account.js';
import { hashConsolePassword } from './console-password.js';
import { registerConsole } from './console-auth.js';
import { isConsoleManagementPath, isLocalConsoleClient } from './console-network.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'console-account-')); directories.push(path); return path; }
it('bootstraps private credentials once and preserves imported passwords', async () => {
  const dataDirectory = await directory();
  const account = await openConsoleAccount({ dataDirectory });
  const credentials = await readFile(join(dataDirectory, 'bootstrap-credentials.txt'), 'utf8');
  const password = credentials.match(/Password: (.+)/)![1]!;
  expect(await account.authenticate('admin', password)).toBe(true);
  expect((await stat(join(dataDirectory, 'console-account.json'))).mode & 0o777).toBe(0o600);
  expect((await stat(join(dataDirectory, 'bootstrap-credentials.txt'))).mode & 0o777).toBe(0o600);
  const reopened = await openConsoleAccount({ dataDirectory });
  expect(await reopened.authenticate('admin', password)).toBe(true);
  expect(await readFile(join(dataDirectory, 'bootstrap-credentials.txt'), 'utf8')).toBe(credentials);
  const imported = await openConsoleAccount({ dataDirectory: await directory(), legacyPasswordHash: await hashConsolePassword('existing-password') });
  expect(await imported.authenticate('admin', 'existing-password')).toBe(true);
});
it('updates with CAS and permits offline recovery', async () => {
  const dataDirectory = await directory();
  const account = await openConsoleAccount({ dataDirectory, legacyPasswordHash: await hashConsolePassword('existing-password') });
  await expect(account.update({ ...account.read(), current_password: 'wrong-password', username: 'newadmin' })).rejects.toMatchObject({ code: 'invalid_current_password' });
  await account.update({ ...account.read(), current_password: 'existing-password', username: 'newadmin', new_password: 'replacement-password' });
  expect(account.credentialRevision()).toBe(2);
  await expect(account.update({ ...account.read(), revision: 1, current_password: 'replacement-password' })).rejects.toMatchObject({ code: 'account_revision_conflict' });
  await account.recover({ new_password: 'recovered-password', allow_remote_management: true });
  expect(await (await openConsoleAccount({ dataDirectory })).authenticate('newadmin', 'recovered-password')).toBe(true);
});
it('rejects proxy spoofing and guards management paths only', () => {
  expect(isLocalConsoleClient('203.0.113.1', '127.0.0.1')).toBe(false);
  expect(isLocalConsoleClient('10.0.0.2', '203.0.113.1')).toBe(false);
  expect(isLocalConsoleClient('10.0.0.2', '127.0.0.1, 203.0.113.1', ['10.0.0.2'])).toBe(false);
  expect(isLocalConsoleClient('10.0.0.2', undefined, ['10.0.0.2'])).toBe(false);
  expect(isLocalConsoleClient('10.0.0.2', '192.168.1.2', ['10.0.0.2'])).toBe(true);
  expect(isLocalConsoleClient('::ffff:127.0.0.1', undefined)).toBe(true);
  for (const path of ['/admin/v1/account', '/v1/console/settings', '/v1/console/connections/telegram', '/console/settings']) expect(isConsoleManagementPath(path)).toBe(true);
  expect(isConsoleManagementPath('/admin/v1/calls')).toBe(false);
});
it('requires CSRF, revokes rotated sessions and leaves calls usable with remote management disabled', async () => {
  const assetsDirectory = await directory();
  await writeFile(join(assetsDirectory, 'index.html'), '<html></html>');
  const account = await openConsoleAccount({ dataDirectory: await directory(), legacyPasswordHash: await hashConsolePassword('existing-password') });
  const app = Fastify();
  await registerConsole(app, { account, assetsDirectory, publicOrigin: 'https://console.example' }, admin => { admin.get('/calls', async () => []); admin.get('/settings', async () => ({})); });
  try {
    const login = await app.inject({ method: 'POST', url: '/admin/v1/session', headers: { origin: 'https://console.example' }, payload: { username: 'admin', password: 'existing-password' } });
    expect(login.statusCode).toBe(200);
    const headers = { origin: 'https://console.example', cookie: login.headers['set-cookie']!.toString().split(';')[0]!, 'x-csrf-token': login.json().csrf_token };
    const payload = { ...account.read(), current_password: 'existing-password', allow_remote_management: false };
    const csrf = await app.inject({ method: 'PUT', url: '/admin/v1/account', headers: { origin: headers.origin, cookie: headers.cookie }, payload });
    expect(csrf.statusCode).toBe(403);
    const update = await app.inject({ method: 'PUT', url: '/admin/v1/account', headers, payload });
    expect(update.json().login_required).toBe(false);
    expect((await app.inject({ url: '/admin/v1/settings', headers, remoteAddress: '203.0.113.1' })).statusCode).toBe(403);
    expect((await app.inject({ url: '/console/settings', remoteAddress: '203.0.113.1' })).statusCode).toBe(403);
    expect((await app.inject({ url: '/admin/v1/calls', headers, remoteAddress: '203.0.113.1' })).statusCode).toBe(200);
    const rotation = await app.inject({ method: 'PUT', url: '/admin/v1/account', headers, payload: { ...account.read(), current_password: 'existing-password', username: 'newadmin' } });
    expect(rotation.json().login_required).toBe(true);
    expect((await app.inject({ url: '/admin/v1/calls', headers })).statusCode).toBe(401);
  } finally { await app.close(); }
});
