export type ResponsesDelegationConfig = {
  model: string;
  instructions?: string;
  max_output_tokens?: number;
  parallel_tool_calls?: boolean;
  reasoning?: { effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' };
  service_tier?: 'auto' | 'default' | 'flex' | 'priority';
  text?: { verbosity: 'low' | 'medium' | 'high' };
  tool_choice?: 'auto' | 'required' | 'none';
  tools?: Array<{ type: 'web_search' }>;
};
export type LiveDelegationConfig = { type: 'client' } | { type: 'responses'; responses: ResponsesDelegationConfig };

/** Emit only the supported Live subset; client delegation never receives backend tools. */
export function serializeDelegation(config: LiveDelegationConfig): LiveDelegationConfig {
  if (config.type === 'client') return { type: 'client' };
  if (config.type !== 'responses' || !config.responses || typeof config.responses.model !== 'string' || !config.responses.model.trim()) throw new Error('Invalid Responses delegation model');
  const source = config.responses;
  if (source.max_output_tokens !== undefined && (!Number.isSafeInteger(source.max_output_tokens) || source.max_output_tokens < 16)) throw new Error('Invalid Responses output token limit');
  if (source.tools?.some(tool => tool.type !== 'web_search')) throw new Error('Unsupported Live Responses tool');
  if (source.reasoning && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(source.reasoning.effort)) throw new Error('Invalid Responses reasoning effort');
  if (source.service_tier && !['auto', 'default', 'flex', 'priority'].includes(source.service_tier)) throw new Error('Invalid Responses service tier');
  if (source.text && !['low', 'medium', 'high'].includes(source.text.verbosity)) throw new Error('Invalid Responses verbosity');
  if (source.tool_choice && !['auto', 'required', 'none'].includes(source.tool_choice)) throw new Error('Invalid Responses tool choice');
  return { type: 'responses', responses: {
    model: source.model,
    ...(source.instructions === undefined ? {} : { instructions: source.instructions }),
    ...(source.max_output_tokens === undefined ? {} : { max_output_tokens: source.max_output_tokens }),
    ...(source.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: source.parallel_tool_calls }),
    ...(source.reasoning ? { reasoning: { effort: source.reasoning.effort } } : {}),
    ...(source.service_tier ? { service_tier: source.service_tier } : {}),
    ...(source.text ? { text: { verbosity: source.text.verbosity } } : {}),
    ...(source.tool_choice ? { tool_choice: source.tool_choice } : {}),
    ...(source.tools ? { tools: source.tools.map(() => ({ type: 'web_search' as const })) } : {}),
  } };
}
