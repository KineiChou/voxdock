# Call from an agent

VoxDock provides four stdio MCP tools for an agent running in Codex, Claude Code or another MCP host. The MCP process connects to your existing bridge through its HTTP control API using a scoped agent credential. It does not run the platform adapters or a second bridge.

This is an experimental, source-installed integration available on `main` after the v0.1.0 tag. There is no published npm package or remote HTTP MCP endpoint. [Platform and handset limitations](limitations.md) still apply.

## Prepare the bridge and context

Install and configure [the bridge](install.md), link an account, verify a receiving target, and configure the [business backend](backend.md). The backend must already resolve the `context_ref` used in a call request and supply fresh purpose/facts before dialing and greeting. An invented context reference does not create a briefing. MCP does not upload inline text, create backend context, execute project work, or install an automatic notification/routing worker.

Only request an actual phone call when the user has authorized it. Reading targets, listing tools and starting the MCP process do not dial a phone. Real calls use platform accounts and may incur provider charges.

## Issue a scoped credential

Use the operator CLI against the running bridge. First obtain the configured target IDs, then choose the targets this agent may use:

```sh
pnpm voxdock targets --config ./instance/voxdock.config.json
pnpm voxdock agent create --config ./instance/voxdock.config.json \
  --name coding-assistant --target owner-whatsapp --allow-end \
  --out /absolute/private/voxdock-agent.token
pnpm voxdock agent list --config ./instance/voxdock.config.json
```

`--target` accepts a comma-separated list of configured target IDs. `--allow-end` is optional; without it the credential cannot end calls. `--out` must name a new file in an existing private directory. The CLI reserves it with mode `0600`, writes the token there and prints only credential metadata and the file path. It never prints the token. Keep the file outside version control and model context. For a remote bridge, transfer it privately to the machine running the MCP host.

A scoped credential can:

- Read capabilities and list only its allowed, currently enabled targets, represented as `{ id, channel, enabled }`.
- Request an outbound call to those targets, subject to the normal readiness, expiry and capacity checks.
- Read only calls created under its own stable agent identity and within its allowed targets.
- End those same calls only when `can_end_calls` is enabled.

It cannot list all calls, inspect other agents' or operator/inbound calls, read transcripts/audit records/events, deliver backend results, change settings, pair accounts, pause/resume the bridge or manage credentials. Keep the administrator control token out of MCP configuration. These credentials provide limited access within a single-operator deployment, not multi-user tenancy.

Rotate or revoke using the ID returned by create/list:

```sh
pnpm voxdock agent rotate AGENT_ID --config ./instance/voxdock.config.json \
  --out /absolute/private/voxdock-agent-next.token
pnpm voxdock agent revoke AGENT_ID --config ./instance/voxdock.config.json
```

Rotation immediately invalidates the old token while preserving agent identity, owned calls and idempotency history. Update the host's token-file path and restart its MCP process; the token is read at startup. Revocation rejects subsequent requests and cannot be undone by rotation. Neither operation hangs up an existing call. Use an authorized call control separately when termination is required. Changing target or end-call permissions requires a new credential and revocation of the old one; the new identity does not inherit old calls.

If credential issuance has an unknown HTTP outcome, inspect `agent list` before retrying; creation and rotation are not idempotent. A lost response cannot recover the issued token. Rotate a known active credential into a new file or revoke an unwanted credential. If a CLI file-write failure reports that revocation is required, revoke that credential through the operator API/CLI.

### Credential management API

The administrator bearer prefix is `/v1/console`; the browser prefix is `/admin/v1` with cookie authentication and the usual Origin/CSRF requirements. Remote-management restrictions cover these routes. Scoped agent credentials cannot access them.

| Method and suffix | Body | Result |
| --- | --- | --- |
| `GET /agents` | none | `{ agents: [...] }`, metadata only |
| `POST /agents` | `{ name, allowed_targets, can_end_calls? }` | `201 { agent, token }` |
| `POST /agents/:id/rotate` | none | `{ agent, token }`; old token invalidated |
| `POST /agents/:id/revoke` | none | Revoked agent metadata |

Creation requires a nonblank name of at most 100 characters and 1–100 unique, configured target references; unknown body fields are rejected. `can_end_calls` defaults to `false`. Agent IDs are UUIDs. The bridge stores token hashes in its private data directory, not recoverable plaintext tokens. Create/rotate API responses contain a one-time secret: save them privately and never paste them into a conversation or log.

## Register the source launcher

On the MCP host, install Node.js **24** and the locked workspace dependencies with `pnpm install --frozen-lockfile`. Use absolute paths to the Node 24 binary, source launcher and token file. The launcher resolves its TypeScript runtime and modules relative to the source checkout, so it works from any working directory.

Required environment variables:

| Variable | Value |
| --- | --- |
| `VOXDOCK_BASE_URL` | Fixed bridge origin, for example `https://voice.example.com`; no path prefix, credentials, query or fragment |
| `VOXDOCK_AGENT_TOKEN_FILE` | Absolute private scoped-token file path |
| `VOXDOCK_REQUEST_TIMEOUT_MS` | Optional integer 1–60,000; default 15,000 |

HTTPS is required outside `localhost`, `127.0.0.1` and `::1`. The process does not accept a token value or administrator-token environment variable. URL and credentials are host configuration, never tool arguments. Requests do not follow redirects or retry automatically; response bodies are limited to 64 KiB. Standard output is reserved for MCP messages.

Replace the example paths with your installation paths. Registration configures tools; it does not make a call.

**Codex CLI:**

```sh
codex mcp add voxdock \
  --env VOXDOCK_BASE_URL=https://voice.example.com \
  --env VOXDOCK_AGENT_TOKEN_FILE=/absolute/private/voxdock-agent.token \
  -- /absolute/node24/bin/node /absolute/voxdock/apps/mcp/bin/voxdock-mcp.mjs
```

**Claude Code CLI:**

```sh
claude mcp add voxdock --transport stdio --scope user \
  -e VOXDOCK_BASE_URL=https://voice.example.com \
  -e VOXDOCK_AGENT_TOKEN_FILE=/absolute/private/voxdock-agent.token \
  -- /absolute/node24/bin/node /absolute/voxdock/apps/mcp/bin/voxdock-mcp.mjs
```

Use your host's MCP tool permissions to review outbound-call requests. Do not grant blanket call authorization simply because the credential has permission to a target.

## Tools and delivery semantics

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `voxdock_list_targets` | `{}` | Authorized targets, current time, calling-enabled status and request TTL when advertised by the bridge |
| `voxdock_call` | `target_id`, `context_ref`, `correlation_ref`, `idempotency_key`, `expires_at` | Request one outbound call |
| `voxdock_get_call` | `call_id` | Read an owned call's status |
| `voxdock_end_call` | `call_id` | Request termination when the credential permits it |

All schemas reject unknown arguments. No tool takes a raw phone number, provider account, arbitrary URL, credential or transcript request. The list result's `current_time` uses the bridge's `server_time` when available, falling back to the MCP host clock for older bridges; synchronize host and bridge clocks. Choose a future UTC ISO timestamp with `Z`, within the bridge's `max_request_ttl_seconds` (default 300). Each identifier is a reference, not free-form speech.

`voxdock_call` sends the idempotency key as the HTTP header and the remaining four fields as the call body. Persist the original key/body and returned `call_id` with your business operation. Reusing an identical key/body returns the same admission result within that agent identity; changed content conflicts. A new key is a new request.

HTTP `202` means accepted, not connected, heard or approved. Inspect state with `voxdock_get_call`; even `connected` alone does not prove the recipient heard the intended message. An end request is also not proof that the receiving handset has ended the call.

Tool failures return `isError: true` with a sanitized structured error code and, when available, HTTP status. A timeout, connection failure or invalid success response after a mutation can produce `outcome_unknown`: the bridge may already have accepted it. Inspect the known call ID; if creation must be retried, use the **identical key and body**, including the original expiry. Never generate a fresh key/expiry or redial automatically to resolve uncertainty. A call in `uncertain` requires [operator reconciliation](state-and-recovery.md).

## Offline verification

With Node 24, `pnpm smoke:mcp` starts the real stdio launcher and an official SDK client against a temporary synthetic HTTP service. It checks initialization, tool discovery, input rejection, status/termination, identical retry identity and sanitized unknown outcomes without calling a phone or model. This smoke requires loopback socket permission and does not validate a handset conversation.
