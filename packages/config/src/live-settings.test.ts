import { expect, it } from 'vitest';
import { parseConfig } from './index.js';

it('retains client delegation defaults while expanding Live preferences', () => {
  const live = parseConfig({ live: { voice: 'quartz', language: 'ja' } }).live;
  expect(live).toMatchObject({
    model: 'gpt-live-1', voice: 'quartz', language: 'ja', delegation: 'client',
    instructions: '', greeting_enabled: true, custom_voice_id: '', store: false,
    sample_rate_hz: { telegram: 24000, whatsapp: 16000 },
    responses: { model: 'gpt-5.6-sol', instructions: '', reasoning_effort: 'low',
      max_output_tokens: 1024, service_tier: 'auto', verbosity: 'low', web_search: false,
      tool_choice: 'auto', parallel_tool_calls: true },
  });
});
it('allows supported Responses preferences and rejects required tools without a tool', () => {
  expect(parseConfig({ live: { delegation: 'responses', custom_voice_id: 'voice_custom',
    responses: { web_search: true, tool_choice: 'required', reasoning_effort: 'minimal' },
  } }).live.responses).toMatchObject({ web_search: true, tool_choice: 'required', reasoning_effort: 'minimal' });
  expect(() => parseConfig({ live: { delegation: 'responses', responses: { tool_choice: 'required' } } })).toThrow(/requires an enabled tool/);
  expect(parseConfig({ live: { delegation: 'client', responses: { tool_choice: 'required' } } }).live.delegation).toBe('client');
});
it.each([
  { responses: { allowed_domains: ['example.com'] } },
  { responses: { search_context_size: 'high' } },
  { responses: { reasoning_effort: 'max' } },
  { responses: { max_output_tokens: 15 } },
  { responses: { max_output_tokens: 16385 } },
  { responses: { service_tier: 'unrecognized' } },
  { instructions: 'x'.repeat(16001) },
  { responses: { instructions: 'x'.repeat(16001) } },
  { custom_voice_id: 'https://example.com/voice' },
  { store: true },
  { sample_rate_hz: { telegram: 48000 } },
])('rejects unsupported or out-of-bounds Live settings %#', live => {
  expect(() => parseConfig({ live })).toThrow();
});
