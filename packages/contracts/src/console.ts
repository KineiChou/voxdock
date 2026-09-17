import type { CallEvent, CallState, CallStatus, Channel, DelegationResult, TranscriptFragment } from './index.js';

export type TranscriptAvailability = 'available' | 'empty' | 'expired' | 'disabled';
export interface ConsoleUsage {
  day: string;
  zone: string;
  seconds: number;
  status: 'reserved' | 'settled' | 'unknown';
}
export interface DelegationCounts {
  total: number;
  completed: number;
  failed: number;
  pending: number;
}
export interface ConsoleCallSummary {
  call: CallStatus;
  channel: Channel | null;
  actor_kind: 'operator' | 'incoming' | null;
  connected: boolean | null;
  connected_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  had_uncertain_state: boolean | null;
  can_end: boolean;
  usage: ConsoleUsage | null;
  delegations: DelegationCounts;
  transcript_availability: TranscriptAvailability;
}
export interface ConsoleCallQuery {
  cursor?: string;
  limit?: number;
  channel?: Channel | 'unknown';
  direction?: 'inbound' | 'outbound';
  state?: CallState;
  from?: string;
  to?: string;
}
export interface ConsoleCallPage {
  items: ConsoleCallSummary[];
  total: number;
  next_cursor: string | null;
}
export interface ConsoleOverview {
  generated_at: string;
  timezone: string;
  days: 1 | 7 | 30;
  period_from: string;
  totals: {
    calls: number;
    connected_calls: number;
    observed_calls: number;
    unknown_outcomes: number;
    connection_rate: number | null;
    settled_live_seconds: number;
    reserved_live_seconds: number;
    unknown_live_seconds: number;
    delegations: DelegationCounts;
  };
  daily: Array<{ date: string; calls: number; connected_calls: number; settled_live_seconds: number }>;
  channels: Array<{ channel: Channel | 'unknown'; calls: number }>;
  today_usage: {
    date: string;
    limit_seconds: number;
    settled_seconds: number;
    reserved_seconds: number;
    unknown_seconds: number;
    remaining_seconds: number;
  };
  active_calls: ConsoleCallSummary[];
  recent_calls: ConsoleCallSummary[];
  attention_calls: ConsoleCallSummary[];
}
export interface ConsoleCallDetail {
  summary: ConsoleCallSummary;
  events: CallEvent[];
  delegations: Array<{
    delegation_id: string;
    context_revision: number;
    occurred_at: string;
    completeness: 'partial' | 'final';
    latest_result: DelegationResult | null;
  }>;
}
export interface ConsoleTranscriptPage {
  fragments: TranscriptFragment[];
  next_cursor: string | null;
  availability: TranscriptAvailability;
}
export interface ConsoleSession {
  authenticated: true;
  csrf_token: string;
  expires_at: string;
}
export interface ConsoleConnection {
  channel: Channel;
  authenticated: boolean;
  enabled: boolean;
  ready: boolean;
  account_ref: string | null;
  status: 'disabled' | 'ready' | 'not_ready';
  targets: Array<{ id: string; enabled: boolean; principal_ref: string }>;
}
export interface ConsoleConnections {
  checked_at: string;
  channels: ConsoleConnection[];
}
export interface ConsoleSettings {
  mode: 'file' | 'managed';
  calling: {
    configured_enabled: boolean;
    paused: boolean;
    accepting_calls: boolean;
    status: 'ready' | 'paused' | 'disabled' | 'busy' | 'not_ready';
    can_pause: boolean;
    can_resume: boolean;
    resume_blocked_reason: string | null;
    max_call_seconds: number;
    daily_live_seconds: number;
    ring_timeout_seconds: number;
    max_request_ttl_seconds: number;
  };
  live: { model: string; voice: string; language: string; credential_configured: boolean };
  backend: { configured: boolean; id: string | null };
  records: { raw_audio: false; transcript_retention_days: number; metadata_retention_days: number };
  timezone: string;
}
