import { Type, type Static } from '@sinclair/typebox';

const strict = { additionalProperties: false };
export const LiveDelegationSchema = Type.Union([Type.Literal('client'), Type.Literal('responses')], { default: 'client' });
export const LiveReasoningEffortSchema = Type.Union((['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const).map(value => Type.Literal(value)), { default: 'low' });
export const LiveServiceTierSchema = Type.Union((['auto', 'default', 'flex', 'priority'] as const).map(value => Type.Literal(value)), { default: 'auto' });
export const LiveVerbositySchema = Type.Union((['low', 'medium', 'high'] as const).map(value => Type.Literal(value)), { default: 'low' });
export const LiveToolChoiceSchema = Type.Union((['auto', 'required', 'none'] as const).map(value => Type.Literal(value)), { default: 'auto' });
export const LiveResponsesPreferencesSchema = Type.Object({
  model: Type.String({ minLength: 1, maxLength: 80, default: 'gpt-5.6-sol' }),
  instructions: Type.String({ maxLength: 16000, default: '' }),
  reasoning_effort: LiveReasoningEffortSchema,
  max_output_tokens: Type.Integer({ minimum: 16, maximum: 16384, default: 1024 }),
  service_tier: LiveServiceTierSchema,
  verbosity: LiveVerbositySchema,
  web_search: Type.Boolean({ default: false }),
  tool_choice: LiveToolChoiceSchema,
  parallel_tool_calls: Type.Boolean({ default: true }),
}, { ...strict, default: {} });
export const LivePreferencesSchema = Type.Object({
  model: Type.Literal('gpt-live-1', { default: 'gpt-live-1' }),
  voice: Type.String({ minLength: 1, maxLength: 80, default: 'marin' }),
  language: Type.String({ minLength: 2, maxLength: 80, default: 'en' }),
  instructions: Type.String({ maxLength: 16000, default: '' }),
  greeting_enabled: Type.Boolean({ default: true }),
  custom_voice_id: Type.String({ maxLength: 80, pattern: '^(?:voice_[A-Za-z0-9_-]+)?$', default: '' }),
  delegation: LiveDelegationSchema,
  responses: LiveResponsesPreferencesSchema,
}, { ...strict, default: {} });
export type LivePreferences = Static<typeof LivePreferencesSchema>;
export type LiveResponsesPreferences = Static<typeof LiveResponsesPreferencesSchema>;

export function livePreferencesValid(value: LivePreferences): boolean {
  return value.delegation !== 'responses' || value.responses.web_search || value.responses.tool_choice !== 'required';
}
