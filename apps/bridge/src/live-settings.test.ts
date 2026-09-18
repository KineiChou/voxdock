import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseConfig } from '@voxdock/config';
import { CallStore } from '@voxdock/core';
import { ConfigurationStore } from './configuration-store.js';
import { RuntimeManager } from './runtime-manager.js';
import { createBridgeServer } from './server.js';
import { runCli } from './cli-commands.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'live-settings-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const baseline = parseConfig({ service: { data_dir: directory } });
  const configuration = new ConfigurationStore(baseline, directory, directory);
  configuration.prepareSessionDirectory();
  return { directory, baseline, configuration };
}
it('fills old managed Live defaults without changing revision, account state, secrets or file bytes', () => {
  const f = fixture();
  const settings = f.configuration.view().settings;
  settings.whatsapp.account_ref = 'stable-account';
  settings.targets = [{ id: 'stable-target', channel: 'whatsapp', account_ref: 'stable-account', peer_id: '15550001', principal_ref: 'owner', enabled: false }];
  f.configuration.prepare({ expected_revision: 0, settings, secrets: { live_api_key: 'synthetic-secret' } }).commit();
  const filename = join(f.directory, 'managed-configuration.json');
  const legacy = JSON.parse(readFileSync(filename, 'utf8'));
  legacy.settings.live = { model: 'gpt-live-1', voice: 'quartz', language: 'ja' };
  const serialized = JSON.stringify(legacy);
  writeFileSync(filename, serialized);
  const reopened = new ConfigurationStore(f.baseline, f.directory, f.directory);
  expect(reopened.view()).toMatchObject({ revision: 1, credentials: { live_api_key: true }, settings: {
    live: { voice: 'quartz', language: 'ja', delegation: 'client', greeting_enabled: true, responses: { web_search: false } },
    whatsapp: legacy.settings.whatsapp, targets: legacy.settings.targets,
  } });
  expect(readFileSync(filename, 'utf8')).toBe(serialized);
  expect(reopened.effective().live.api_key_file).toBe(f.configuration.effective().live.api_key_file);
});
it('shares legacy defaults, validation and persistence through the configuration HTTP/CLI endpoint', async () => {
  const f = fixture();
  const store = new CallStore(join(f.directory, 'state.sqlite'));
  cleanup.push(() => store.close());
  const config = f.configuration.effective();
  const start = vi.fn(async () => ({ readyChannels: new Set<'telegram'>(), onCallCreated: vi.fn(), onEnd: vi.fn(), onResult: vi.fn(), close: vi.fn(async () => {}) }));
  const manager = new RuntimeManager(config, store, f.directory, start, f.configuration);
  cleanup.push(() => manager.close());
  const app = await createBridgeServer({ config, store, controlToken: 'x'.repeat(32), management: manager });
  cleanup.push(() => app.close());
  const url = '/v1/console/settings/configuration';
  const headers = { authorization: `Bearer ${'x'.repeat(32)}` };
  const settings = f.configuration.view().settings;
  const legacy = { ...settings, live: { model: 'gpt-live-1', voice: 'marin', language: 'en' } };
  const first = await app.inject({ method: 'PUT', url, headers, payload: { expected_revision: 0, settings: legacy } });
  expect(first.statusCode).toBe(200);
  const next = first.json();
  expect(next.settings.live.responses.max_output_tokens).toBe(1024);
  next.settings.live.delegation = 'responses';
  next.settings.live.responses = { ...next.settings.live.responses, web_search: true, reasoning_effort: 'minimal', tool_choice: 'required', model: 'custom-model' };
  next.settings.live.instructions = 'Use short sentences.';
  const payload = { expected_revision: 1, settings: next.settings };
  expect((await app.inject({ method: 'PUT', url, headers, payload })).statusCode).toBe(200);
  expect(new ConfigurationStore(f.baseline, f.directory, f.directory).effective().live).toMatchObject(next.settings.live);
  next.settings.live.responses.web_search = false;
  expect((await app.inject({ method: 'PUT', url, headers, payload: { expected_revision: 2, settings: next.settings } })).statusCode).toBe(400);
  expect(f.configuration.view().revision).toBe(2);
  const configFile = join(f.directory, 'bridge.json');
  const tokenFile = join(f.directory, 'control.token');
  const inputFile = join(f.directory, 'update.json');
  writeFileSync(tokenFile, 'x'.repeat(32), { mode: 0o600 });
  writeFileSync(configFile, JSON.stringify({ ...f.baseline, security: { control_token_file: tokenFile } }), { mode: 0o600 });
  next.settings.live.responses.web_search = true;
  next.settings.live.responses.verbosity = 'high';
  writeFileSync(inputFile, JSON.stringify({ expected_revision: 2, settings: next.settings }), { mode: 0o600 });
  const output: string[] = [];
  await runCli(['configuration', '--config', configFile, '--file', inputFile], {
    write: value => { output.push(value); },
    fetch: async (input, init) => {
      expect(new URL(String(input)).pathname).toBe(url);
      const response = await app.inject({ url, method: 'PUT',
        headers: Object.fromEntries(new Headers(init?.headers)), payload: String(init?.body) });
      return new Response(response.body, { status: response.statusCode });
    },
  });
  expect(JSON.parse(output[0]!)).toMatchObject({ revision: 3, settings: { live: { responses: { verbosity: 'high' } } } });
  const options = (await app.inject({ url: '/v1/console/settings/options', headers })).json();
  expect(options.delegation_modes.map((option: { value: string }) => option.value)).toEqual(['client', 'responses']);
  expect(options.reasoning_efforts.map((option: { value: string }) => option.value)).toContain('minimal');
  expect(options.reasoning_efforts.map((option: { value: string }) => option.value)).not.toContain('max');
});
