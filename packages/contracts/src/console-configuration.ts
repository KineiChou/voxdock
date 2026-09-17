import { Type, type Static } from '@sinclair/typebox';

const strict = { additionalProperties: false };
const ref = Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:/-]*$' });
export const ConsoleConfigurationSchema = Type.Object({
  calling: Type.Object({
    enabled: Type.Boolean(),
    max_call_seconds: Type.Integer({ minimum: 1, maximum: 3600 }),
    daily_live_seconds: Type.Integer({ minimum: 1, maximum: 86400 }),
    ring_timeout_seconds: Type.Integer({ minimum: 1, maximum: 120 }),
    max_request_ttl_seconds: Type.Integer({ minimum: 1, maximum: 3600 }),
  }, strict),
  live: Type.Object({ model: Type.Literal('gpt-live-1'), voice: Type.String({ minLength: 1, maxLength: 80 }), language: Type.String({ minLength: 2, maxLength: 80 }) }, strict),
  backend: Type.Union([Type.Null(), Type.Object({ id: ref, base_url: Type.String({ minLength: 1, maxLength: 2048 }), ack_timeout_ms: Type.Integer({ minimum: 100, maximum: 30000 }) }, strict)]),
  records: Type.Object({ transcript_retention_days: Type.Integer({ minimum: 0, maximum: 30 }), metadata_retention_days: Type.Integer({ minimum: 1, maximum: 365 }) }, strict),
  telegram: Type.Object({ enabled: Type.Boolean(), account_ref: ref, api_id: Type.Union([Type.Null(), Type.Integer({ minimum: 1, maximum: 2147483647 })]) }, strict),
  whatsapp: Type.Object({ enabled: Type.Boolean(), account_ref: ref }, strict),
  targets: Type.Array(Type.Object({ id: ref, channel: Type.Union([Type.Literal('telegram'), Type.Literal('whatsapp')]), account_ref: ref, principal_ref: ref, peer_id: Type.String({ minLength: 1, maxLength: 160 }), enabled: Type.Boolean() }, strict), { maxItems: 2 }),
}, strict);
const secret = Type.Optional(Type.String({ minLength: 1, maxLength: 8192 }));
export const ConsoleConfigurationUpdateSchema = Type.Object({
  expected_revision: Type.Integer({ minimum: 0 }), settings: ConsoleConfigurationSchema,
  secrets: Type.Optional(Type.Object({ live_api_key: secret, backend_request_token: secret, backend_event_signing_key: secret, telegram_api_hash: secret }, strict)),
}, strict);
export type ConsoleConfiguration = Static<typeof ConsoleConfigurationSchema>;
export type ConsoleConfigurationUpdate = Static<typeof ConsoleConfigurationUpdateSchema>;
export type ConfigurationSecret = keyof NonNullable<ConsoleConfigurationUpdate['secrets']>;
export interface ConsoleConfigurationView {
  revision: number;
  settings: ConsoleConfiguration;
  credentials: Record<ConfigurationSecret, boolean>;
  deployment: { whatsapp_available: boolean; whatsapp_endpoint: string | null; timezone: string };
  applying: boolean;
}
export interface ConsoleConversationTurn {
  id: string; session_id: string; speaker: 'user' | 'assistant';
  start_ms: number; end_ms: number; text: string; final: boolean; fragment_count: number;
}
export interface ConsoleConversation {
  turns: ConsoleConversationTurn[];
  availability: 'available' | 'empty' | 'expired' | 'disabled';
}
