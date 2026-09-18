import { expect, test } from 'vitest';
import { parseConfig } from '@voxdock/config';
import { liveSessionSettings } from './live-settings.js';

test('default client delegation keeps tools in the external backend', () => {
  const config = parseConfig({ security: { control_token_file: 'control.key' }, live: { responses: { web_search: true } } });
  const session = liveSessionSettings(config.live, 'telegram');
  expect(session.delegation).toEqual({ type: 'client' });
  expect(session.voice).toBe('marin');
  expect(session.instructions).toContain('Stay silent until the opening instruction');
});

test('managed delegation maps every supported setting to the Live wire contract', () => {
  const config = parseConfig({ security: { control_token_file: 'control.key' }, live: {
    delegation: 'responses', custom_voice_id: 'voice_custom', language: 'zh-CN', instructions: 'Speak briefly.', greeting_enabled: false,
    responses: { model: 'gpt-5.6-sol', instructions: 'Cite sources.', reasoning_effort: 'medium', max_output_tokens: 2048,
      service_tier: 'flex', verbosity: 'high', web_search: true, tool_choice: 'required', parallel_tool_calls: false },
  } });
  const session = liveSessionSettings(config.live, 'whatsapp');
  expect(session.voice).toEqual({ id: 'voice_custom' });
  expect(session.instructions).toContain('Wait for the caller');
  expect(session.instructions).toContain('zh-CN');
  expect(session.instructions).toContain('Speak briefly.');
  expect(session.delegation).toEqual({ type: 'responses', responses: {
    model: 'gpt-5.6-sol', instructions: 'Cite sources.', reasoning: { effort: 'medium' }, max_output_tokens: 2048,
    service_tier: 'flex', text: { verbosity: 'high' }, tools: [{ type: 'web_search' }], tool_choice: 'required', parallel_tool_calls: false,
  } });
});
