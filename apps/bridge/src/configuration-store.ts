import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { parseConfig, type BridgeConfig } from '@voxdock/config';
import { ConsoleConfigurationSchema, ConsoleConfigurationUpdateSchema, type ConfigurationSecret, type ConsoleConfiguration, type ConsoleConfigurationUpdate, type ConsoleConfigurationView } from '@voxdock/contracts';
import { DomainError } from '@voxdock/core';
import { readPrivateText } from './cli-files.js';

interface ConfigurationState { revision: number; settings: ConsoleConfiguration; secrets: Partial<Record<ConfigurationSecret, string>> }
const slots = ['live_api_key', 'backend_request_token', 'backend_event_signing_key', 'telegram_api_hash'] as const;

export function writePrivateJson(filename: string, data: unknown): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, filename);
}

function fromConfig(config: BridgeConfig): ConsoleConfiguration {
  const tg = config.channels.telegram;
  const apiId = tg.api_id ?? Number(tg.api_id_env ? process.env[tg.api_id_env] : undefined);
  return {
    calling: { enabled: config.calling.enabled, max_call_seconds: config.calling.max_call_seconds, daily_live_seconds: config.calling.daily_live_seconds, ring_timeout_seconds: config.calling.ring_timeout_seconds, max_request_ttl_seconds: config.calling.max_request_ttl_seconds },
    live: { model: config.live.model, voice: config.live.voice, language: config.live.language },
    backend: config.backend ? { id: config.backend.id, base_url: config.backend.base_url, ack_timeout_ms: config.backend.ack_timeout_ms } : null,
    records: { transcript_retention_days: config.records.transcript_retention_days, metadata_retention_days: config.records.metadata_retention_days },
    telegram: { enabled: tg.enabled, account_ref: tg.account_ref ?? 'telegram-owner', api_id: Number.isSafeInteger(apiId) && apiId > 0 ? apiId : null },
    whatsapp: { enabled: config.channels.whatsapp.enabled, account_ref: config.channels.whatsapp.account_ref ?? 'whatsapp-owner' },
    targets: config.targets.map(target => ({ id: target.id, channel: target.channel, account_ref: target.account_ref, principal_ref: target.principal_ref, enabled: target.enabled, peer_id: target.peer_id ?? (target.peer_id_env ? process.env[target.peer_id_env] : '') ?? '' })),
  };
}

/** Only application fields override deployment configuration. Secret values never enter this document. */
export class ConfigurationStore {
  private state: ConfigurationState;
  private readonly filename: string;
  readonly secretsDirectory: string;
  readonly telegramSession: string;
  constructor(private readonly baseline: BridgeConfig, private readonly directory: string, dataDirectory: string) {
    this.filename = join(dataDirectory, 'managed-configuration.json');
    this.secretsDirectory = join(dataDirectory, 'secrets');
    this.telegramSession = join(this.secretsDirectory, 'telegram.session');
    this.state = { revision: 0, settings: fromConfig(baseline), secrets: {} };
    if (existsSync(this.filename)) {
      const text = readPrivateText(this.filename);
      const parsed = JSON.parse(text) as ConfigurationState;
      if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 1 || !Value.Check(ConsoleConfigurationSchema, parsed.settings) || !parsed.secrets || typeof parsed.secrets !== 'object' || Object.entries(parsed.secrets).some(([slot, path]) => !slots.includes(slot as ConfigurationSecret) || typeof path !== 'string' || !/^[-a-z_0-9.]+$/.test(path))) throw new Error('invalid_managed_configuration');
      this.state = parsed;
    }
  }
  prepareSessionDirectory(): void {
    mkdirSync(this.secretsDirectory, { recursive: true, mode: 0o700 });
    const previous = this.baseline.channels.telegram.session_file;
    if (this.state.revision === 0 && previous && existsSync(resolve(this.directory, previous)) && !existsSync(this.telegramSession)) {
      copyFileSync(resolve(this.directory, previous), this.telegramSession);
      chmodSync(this.telegramSession, 0o600);
    }
  }
  effective(state = this.state): BridgeConfig {
    const config = structuredClone(this.baseline);
    const settings = state.settings;
    Object.assign(config.calling, settings.calling);
    Object.assign(config.live, settings.live);
    Object.assign(config.records, settings.records);
    const secretFile = (slot: ConfigurationSecret, fallback?: string) => state.secrets[slot] ? join(this.secretsDirectory, state.secrets[slot]!) : fallback;
    const liveKey = secretFile('live_api_key', config.live.api_key_file);
    if (liveKey) config.live.api_key_file = liveKey;
    if (settings.backend) {
      config.backend = { ...settings.backend, request_token_file: secretFile('backend_request_token', config.backend?.request_token_file) ?? join(this.secretsDirectory, 'backend_request_token.unset'), event_signing_key_file: secretFile('backend_event_signing_key', config.backend?.event_signing_key_file) ?? join(this.secretsDirectory, 'backend_event_signing_key.unset') };
    } else delete config.backend;
    const tg = { ...config.channels.telegram, enabled: settings.telegram.enabled, account_ref: settings.telegram.account_ref, session_file: this.telegramSession };
    if (settings.telegram.api_id !== null) tg.api_id = settings.telegram.api_id;
    else { delete tg.api_id; delete tg.api_id_env; }
    const hash = secretFile('telegram_api_hash', tg.api_hash_file);
    if (hash) tg.api_hash_file = hash;
    config.channels.telegram = tg as BridgeConfig['channels']['telegram'];
    config.channels.whatsapp = { ...config.channels.whatsapp, ...settings.whatsapp } as BridgeConfig['channels']['whatsapp'];
    config.targets = settings.targets.map(target => ({ ...target }));
    try { return parseConfig(config); } catch { throw new DomainError('invalid_configuration', 400); }
  }
  view(applying = false): ConsoleConfigurationView {
    const config = this.effective();
    const references = { live_api_key: config.live.api_key_file, backend_request_token: config.backend?.request_token_file, backend_event_signing_key: config.backend?.event_signing_key_file, telegram_api_hash: config.channels.telegram.api_hash_file };
    const credentials = Object.fromEntries(slots.map(slot => {
      try { return [slot, !!references[slot] && !!readPrivateText(resolve(this.directory, references[slot]!))]; } catch { return [slot, false]; }
    })) as Record<ConfigurationSecret, boolean>;
    return { revision: this.state.revision, settings: structuredClone(this.state.settings), credentials, deployment: { whatsapp_available: !!config.channels.whatsapp.endpoint && !!config.channels.whatsapp.media_token_file, whatsapp_endpoint: config.channels.whatsapp.endpoint ?? null, timezone: config.timezone }, applying };
  }
  prepare(input: ConsoleConfigurationUpdate): { config: BridgeConfig; commit: () => void } {
    if (!Value.Check(ConsoleConfigurationUpdateSchema, input)) throw new DomainError('invalid_configuration', 400);
    if (input.expected_revision !== this.state.revision) throw new DomainError('revision_conflict', 409);
    const next: ConfigurationState = { revision: this.state.revision + 1, settings: structuredClone(input.settings), secrets: { ...this.state.secrets } };
    for (const slot of slots) {
      const value = input.secrets?.[slot];
      if (value === undefined) continue;
      if (!value.trim() || /[\r\n\0]/.test(value.trim())) throw new DomainError('invalid_credential', 400);
      const name = `${slot}.${randomUUID()}`;
      writeFileSync(join(this.secretsDirectory, name), value.trim() + '\n', { flag: 'wx', mode: 0o600 });
      next.secrets[slot] = name;
    }
    const config = this.effective(next);
    const required: Array<string | undefined> = [];
    if (config.calling.enabled) required.push(config.live.api_key_file, config.backend?.request_token_file, config.backend?.event_signing_key_file);
    if (config.channels.telegram.enabled) required.push(config.channels.telegram.api_hash_file, config.channels.telegram.session_file);
    if (config.channels.whatsapp.enabled) required.push(config.channels.whatsapp.media_token_file);
    try { for (const path of required) { if (!path) throw new Error(); readPrivateText(resolve(this.directory, path)); } }
    catch { throw new DomainError('credentials_required', 400); }
    return { config, commit: () => { writePrivateJson(this.filename, next); this.state = next; } };
  }
}
