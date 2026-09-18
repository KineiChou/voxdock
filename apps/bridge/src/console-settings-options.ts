import { LiveReasoningEffortSchema, LiveServiceTierSchema, LiveVerbositySchema, LiveToolChoiceSchema, type ConsoleSettingsOptions } from '@voxdock/contracts';

// Live's documented default and additional voices, checked 2026-09-17:
// https://developers.openai.com/api/docs/guides/live-conversations#voice-options
export const consoleSettingsOptions: ConsoleSettingsOptions = {
  voices: [
    { value: 'marin', label: 'Marin (default)' },
    { value: 'quartz', label: 'Quartz' },
    { value: 'ripple', label: 'Ripple' },
    { value: 'vesper', label: 'Vesper' },
    { value: 'willow', label: 'Willow' },
    { value: 'stone', label: 'Stone' },
    { value: 'gleam', label: 'Gleam' },
    { value: 'meridian', label: 'Meridian' },
    { value: 'bossa', label: 'Bossa' },
    { value: 'tempo', label: 'Tempo' },
    { value: 'beacon', label: 'Beacon' },
    { value: 'delta', label: 'Delta' },
    { value: 'cinder', label: 'Cinder' },
  ],
  // Preferred conversation languages are prompt hints, not a model capability list.
  languages: [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: 'Chinese, Simplified · 简体中文' },
    { value: 'zh-TW', label: 'Chinese, Traditional · 繁體中文' },
    { value: 'ja', label: 'Japanese · 日本語' },
    { value: 'ko', label: 'Korean · 한국어' },
    { value: 'es', label: 'Spanish · Español' },
    { value: 'fr', label: 'French · Français' },
    { value: 'de', label: 'German · Deutsch' },
    { value: 'it', label: 'Italian · Italiano' },
    { value: 'pt-BR', label: 'Portuguese, Brazil · Português' },
    { value: 'pt-PT', label: 'Portuguese, Portugal · Português' },
    { value: 'ar', label: 'Arabic · العربية' },
    { value: 'hi', label: 'Hindi · हिन्दी' },
    { value: 'id', label: 'Indonesian · Bahasa Indonesia' },
    { value: 'ru', label: 'Russian · Русский' },
    { value: 'tr', label: 'Turkish · Türkçe' },
    { value: 'vi', label: 'Vietnamese · Tiếng Việt' },
  ],
  delegation_modes: [
    { value: 'client', label: 'External agent' },
    { value: 'responses', label: 'OpenAI Responses' },
  ],
  responses_models: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
  ],
  allow_custom_responses_model: true,
  reasoning_efforts: LiveReasoningEffortSchema.anyOf.map(option => ({ value: option.const, label: option.const })),
  service_tiers: LiveServiceTierSchema.anyOf.map(option => ({ value: option.const, label: option.const })),
  verbosities: LiveVerbositySchema.anyOf.map(option => ({ value: option.const, label: option.const })),
  tool_choices: LiveToolChoiceSchema.anyOf.map(option => ({ value: option.const, label: option.const })),
  allow_custom_voice: true,
  allow_custom_language: true,
};
