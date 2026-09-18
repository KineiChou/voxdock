import { closeSync, fsyncSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AgentTokenResponse } from '@voxdock/contracts';
import { CliError } from './cli-files.js';
import type { controlRequest } from './cli-api.js';

type Request = (path: string, options?: Parameters<typeof controlRequest>[3]) => Promise<unknown>;
export async function runAgentCommand(action: string | undefined, id: string | undefined, values: Record<string, string>, allowEnd: boolean, request: Request, output: (value: unknown) => void) {
  const base = '/v1/console/agents';
  if (action === 'list' && !id && !values.out && !values.name && !values.target && !allowEnd) { output(await request(base)); return; }
  if (action === 'revoke' && id && !values.out && !values.name && !values.target && !allowEnd) { output(await request(`${base}/${encodeURIComponent(id)}/revoke`, { method: 'POST' })); return; }
  if (!values.out || !['create', 'rotate'].includes(action ?? '') || (action === 'create' ? !!id || !values.name || !values.target : !id || !!values.name || !!values.target || allowEnd)) throw new CliError('invalid_arguments');
  // Reserve the destination before issuing a credential, so existing files are never overwritten.
  let fd: number;
  try { fd = openSync(values.out, 'wx', 0o600); } catch { throw new CliError('credential_output_unavailable'); }
  let issued: AgentTokenResponse | undefined;
  let written = false;
  try {
    issued = await request(action === 'create' ? base : `${base}/${encodeURIComponent(id!)}/rotate`, {
      method: 'POST', ...(action === 'create' ? { body: { name: values.name, allowed_targets: values.target!.split(','), can_end_calls: allowEnd } } : {}),
    }) as AgentTokenResponse;
    if (!issued.agent?.id || typeof issued.token !== 'string') throw new CliError('invalid_control_response');
    writeFileSync(fd, issued.token + '\n');
    fsyncSync(fd);
    written = true;
  } catch (error) {
    if (issued?.agent?.id) {
      try { await request(`${base}/${encodeURIComponent(issued.agent.id)}/revoke`, { method: 'POST' }); }
      catch { throw new CliError('credential_write_failed_revoke_required'); }
      throw new CliError('credential_write_failed_revoked');
    }
    if (!(error instanceof CliError)) throw new CliError('credential_issuance_uncertain_check_agents');
    throw error;
  } finally {
    closeSync(fd);
    if (!written) { try { unlinkSync(values.out); } catch { /* Preserve the original error. */ } }
  }
  output({ agent: issued.agent, credential_file: values.out });
}
