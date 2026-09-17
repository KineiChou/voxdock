import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseConfig } from '@voxdock/config';
import { hashConsolePassword, verifyConsolePassword } from './console-password.js';
import { runCli } from './cli-commands.js';
import { initDirectory } from './cli-files.js';

it('generates distinct bounded scrypt hashes and rejects malformed costs without deriving them', async () => {
  const password = 'synthetic-console-password';
  const first = await hashConsolePassword(password);
  expect(first).not.toBe(await hashConsolePassword(password));
  expect(await verifyConsolePassword(password, first)).toBe(true);
  expect(await verifyConsolePassword('different-password', first)).toBe(false);
  expect(await verifyConsolePassword(password, first.replace('16384', '1073741824'))).toBe(false);
  await expect(hashConsolePassword('short')).rejects.toThrow('invalid_console_password_length');
});

it('writes a private new hash file without printing the password or hash', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'voxdock-console-password-'));
  try {
    const input = join(directory, 'input');
    const output = join(directory, 'hash');
    writeFileSync(input, 'synthetic-console-password\n', { mode: 0o600 });
    const messages: string[] = [];
    const command = ['console', 'password', '--password-file', input, '--out', output];
    await runCli(command, { write: value => { messages.push(value); } });
    const hash = readFileSync(output, 'utf8').trim();
    expect(await verifyConsolePassword('synthetic-console-password', hash)).toBe(true);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(messages).toEqual(['{"password_hash_written":true}']);
    await expect(runCli(command)).rejects.toThrow('destination_must_be_new');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('allows an exact HTTPS console origin and loopback development only', () => {
  expect(parseConfig({}).console.enabled).toBe(false);
  expect(() => parseConfig({ console: { enabled: true } })).toThrow('Console requires');
  for (const public_origin of ['https://voice.example.test', 'http://127.0.0.1:5173']) {
    expect(parseConfig({ console: { enabled: true, public_origin, password_hash_file: './admin.hash' } }).console.public_origin).toBe(public_origin);
  }
  for (const public_origin of ['http://voice.example.test', 'https://voice.example.test/path', 'https://voice.example.test/', 'https://user:password@voice.example.test', 'https://voice.example.test?token=secret']) {
    expect(() => parseConfig({ console: { public_origin } })).toThrow();
  }
});

it('forwards console query options to the authenticated server without client aggregation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voxdock-console-cli-'));
  try {
    const config = initDirectory(join(root, 'instance'));
    const urls: string[] = [];
    const output: string[] = [];
    const deps = {
      write: (value: string) => { output.push(value); },
      fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input));
        urls.push(url.pathname + url.search);
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /);
        return new Response(JSON.stringify({ server_result: true }));
      },
    };
    await runCli(['overview', '--config', config, '--days', '7'], deps);
    await runCli(['calls', '--config', config, '--channel', 'whatsapp', '--limit', '10'], deps);
    await runCli(['resume', '--online', '--config', config], deps);
    expect(urls).toEqual(['/v1/console/overview?days=7', '/v1/console/calls?channel=whatsapp&limit=10', '/v1/console/control/resume']);
    expect(output.every(value => JSON.parse(value).server_result === true)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
