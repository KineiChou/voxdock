import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCli } from './cli-commands.js';
import { initDirectory } from './cli-files.js';

let directory: string;
let configFile: string;
let inputFile: string;
const flow = '4e3864e3-9c62-45b7-9ccc-f7dbb3178600';
const candidate = 'b16e2db1-116c-4d8a-9078-7a1f0471d2db';
const base = '/v1/console/connections/whatsapp/target-pairings';
const target = { peer_id: '123456789', enabled: true };
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'voxdock-cli-pairing-'));
  configFile = initDirectory(join(directory, 'instance'));
  inputFile = join(directory, 'target.json');
  writeFileSync(inputFile, JSON.stringify(target), { mode: 0o600 });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it.each([
  { args: ['connection', 'refresh', '--flow', flow], path: `/v1/console/connections/flows/${flow}/refresh`, method: 'POST', body: {} },
  { args: ['connection', 'setup', '--channel', 'whatsapp'], path: '/v1/console/connections/whatsapp/setup', method: 'GET', body: undefined },
  { args: ['connection', 'setup', '--channel', 'telegram'], path: '/v1/console/connections/telegram/setup', method: 'GET', body: undefined },
  { args: ['connection', 'connect', '--channel', 'telegram', '--method', 'qr'], path: '/v1/console/connections/telegram/qr', method: 'POST', body: {} },
  { args: ['connection', 'unlink', '--channel', 'whatsapp'], path: '/v1/console/connections/whatsapp/unlink', method: 'POST', body: {} },
  { args: ['connection', 'target', '--channel', 'telegram'], path: '/v1/console/connections/telegram/target', method: 'POST', body: target, input: true },
  { args: ['target-pair', 'start', '--method', 'message'], path: base, method: 'POST', body: { method: 'message' } },
  { args: ['target-pair', 'start', '--method', 'call'], path: base, method: 'POST', body: { method: 'call' } },
  { args: ['target-pair', 'status', '--flow', flow], path: `${base}/${flow}`, method: 'GET', body: undefined },
  { args: ['target-pair', 'confirm', '--flow', flow, '--candidate', candidate], path: `${base}/${flow}/confirm`, method: 'POST', body: { candidate_id: candidate } },
  { args: ['target-pair', 'cancel', '--flow', flow], path: `${base}/${flow}/cancel`, method: 'POST', body: {} },
  { args: ['target-pair', 'start', '--channel', 'telegram', '--method', 'message'], path: base.replace('whatsapp', 'telegram'), method: 'POST', body: { method: 'message' } },
  { args: ['target-pair', 'start', '--channel', 'telegram', '--method', 'call'], path: base.replace('whatsapp', 'telegram'), method: 'POST', body: { method: 'call' } },
  { args: ['target-pair', 'confirm', '--channel', 'telegram', '--flow', flow, '--candidate', candidate], path: `${base.replace('whatsapp', 'telegram')}/${flow}/confirm`, method: 'POST', body: { candidate_id: candidate } },
])('maps $args to the authenticated $method $path request', async test => {
  const response = { accepted: true };
  const transport = vi.fn<typeof fetch>(async () => Response.json(response));
  const write = vi.fn();
  await runCli([...test.args, ...(test.input ? ['--input-file', inputFile] : []), '--config', configFile], { fetch: transport, write });
  expect(transport).toHaveBeenCalledOnce();
  const [url, options] = transport.mock.calls[0]!;
  expect(new URL(String(url)).pathname).toBe(test.path);
  expect(options?.method).toBe(test.method);
  expect(options?.body).toBe(test.body === undefined ? undefined : JSON.stringify(test.body));
  const token = readFileSync(join(directory, 'instance', 'control.token'), 'utf8').trim();
  expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${token}`);
  expect(JSON.parse(write.mock.calls[0]![0])).toEqual(response);
  expect(write.mock.calls[0]![0]).not.toContain(token);
});

it.each([
  ['connection', 'refresh'],
  ['connection', 'refresh', '--flow', flow, '--channel', 'whatsapp'],
  ['connection', 'refresh', '--flow', flow, '--input-file', '/unused.json'],
  ['connection', 'refresh', '--flow', '../unexpected'],
  ['connection', 'connect', '--channel', 'telegram', '--method', 'qr', '--input-file', '/unused.json'],
  ['connection', 'connect', '--channel', 'telegram', '--method', 'unknown'],
  ['connection', 'connect', '--channel', 'whatsapp', '--method', 'qr'],
  ['connection', 'disconnect', '--channel', 'telegram', '--method', 'qr'],
  ['connection', 'status', '--flow', flow, '--method', 'qr'],
  ['connection', 'unlink', '--channel', 'telegram'],
  ['connection', 'target', '--channel', 'telegram'],
  ['target-pair', 'start', '--method', 'unknown'],
  ['target-pair', 'start', '--channel', 'unknown', '--method', 'call'],
  ['target-pair', 'start', '--method', 'message', '--flow', flow],
  ['target-pair', 'confirm', '--flow', flow],
  ['target-pair', 'status', '--flow', flow, '--candidate', candidate],
  ['target-pair', 'cancel', '--flow', '../unexpected'],
])('rejects invalid pairing arguments before sending: %j', async (...args) => {
  const transport = vi.fn<typeof fetch>();
  await expect(runCli([...args, '--config', configFile], { fetch: transport, write: () => {} })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it('preserves a backend stale-confirmation error without retrying', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ error: 'target_pairing_stale' }, { status: 409 }));
  await expect(runCli(['target-pair', 'confirm', '--flow', flow, '--candidate', candidate, '--config', configFile], { fetch: transport, write: () => {} })).rejects.toThrow('target_pairing_stale');
  expect(transport).toHaveBeenCalledOnce();
});
