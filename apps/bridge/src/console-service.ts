import type { ConsoleConnections, ConsoleSettings } from '@voxdock/contracts';
import { DomainError } from '@voxdock/core';
import type { BridgeServerOptions } from './server.js';

export function createConsoleService(options: BridgeServerOptions) {
  const { config, store } = options;
  const ready = { has: (channel: 'telegram' | 'whatsapp') => options.readyChannels?.has(channel) ?? false };
  const blockedReason = () => {
    if (options.management?.managing) return 'management_busy';
    if (!config.calling.enabled) return 'calling_disabled';
    if (store.listCalls().some(call => call.state !== 'ended')) return 'active_or_uncertain_call';
    if (!options.onCallCreated || !config.targets.some(target => target.enabled && config.channels[target.channel].enabled && ready.has(target.channel))) return 'adapter_not_ready';
    return null;
  };
  return {
    pause() { store.setPaused(true); return { paused: true }; },
    resume() {
      const reason = blockedReason();
      if (reason) throw new DomainError(reason, 409);
      store.setPaused(false);
      return { paused: false };
    },
    settings(): ConsoleSettings {
      const paused = store.isPaused(false);
      const reason = blockedReason();
      return {
        mode: options.management ? 'managed' : 'file', timezone: config.timezone,
        calling: {
          configured_enabled: config.calling.enabled, paused,
          accepting_calls: config.calling.enabled && !paused && reason === null,
          status: !config.calling.enabled ? 'disabled' : paused ? 'paused' : reason === 'active_or_uncertain_call' ? 'busy' : reason ? 'not_ready' : 'ready',
          can_pause: config.calling.enabled && !paused,
          can_resume: reason === null, resume_blocked_reason: reason,
          max_call_seconds: config.calling.max_call_seconds,
          daily_live_seconds: config.calling.daily_live_seconds,
          ring_timeout_seconds: config.calling.ring_timeout_seconds,
          max_request_ttl_seconds: config.calling.max_request_ttl_seconds,
        },
        live: { model: config.live.model, voice: config.live.voice, language: config.live.language, credential_configured: !!config.live.api_key_file },
        backend: { configured: !!config.backend, id: config.backend?.id ?? null },
        records: { raw_audio: false, transcript_retention_days: config.records.transcript_retention_days, metadata_retention_days: config.records.metadata_retention_days },
      };
    },
    async connections(): Promise<ConsoleConnections> {
      const accounts = options.connections ? await options.connections.accountStatus() : { telegram: false, whatsapp: false };
      return { checked_at: new Date().toISOString(), channels: (['telegram', 'whatsapp'] as const).map(channel => {
        const connection = config.channels[channel];
        return { channel, authenticated: accounts[channel], enabled: connection.enabled, ready: connection.enabled && ready.has(channel),
          account_ref: connection.account_ref ?? null,
          status: !connection.enabled ? 'disabled' : ready.has(channel) ? 'ready' : 'not_ready',
          targets: config.targets.filter(target => target.channel === channel).map(target => ({ id: target.id, enabled: target.enabled, principal_ref: target.principal_ref })),
        };
      }) };
    },
  };
}
