# Configuration

VoxDock separates deployment settings from application settings. Use **Settings → Configure** for application preferences and **Connections** for account linking. The CLI and authenticated API use the same validation and persistence as the console.

## Configuration sources

The JSON file passed with `--config` defines listening addresses, storage, secret-file references, platform endpoints, console origin and initial application defaults. Relative paths resolve against that file's directory. `pnpm voxdock init ./local` creates a disabled instance and a private control token; `pnpm voxdock doctor --config ./local/voxdock.config.json` checks local prerequisites without contacting platforms or paid APIs.

After the first managed update, `managed-configuration.json` in the data directory supplies application preferences and managed credential references. Its saved values take precedence over application fields in the deployment file. Edit them through the console, CLI or API rather than editing the file while the service runs. Existing configurations receive defaults for newly introduced optional preferences without changing their saved revision or credentials.

Updates apply only while there are no active or uncertain calls or account-management operations. The backend validates the entire update, pauses admission, replaces the runtime and commits one revision. A successful apply restores normal availability while preserving an explicit maintenance pause. Failed replacement rolls back when cleanup is confirmed; uncertain cleanup retains a recovery pause.

## First-time setup

1. Enable the console and set its exact `public_origin` in the deployment file; use HTTPS outside loopback. Start the bridge, open `/console/` and read the generated private bootstrap credentials locally. Change the password in Settings.
2. Configure the GPT-Live API key and the external backend URL, request token and event-signing key. The backend supplies fresh call context and receives events in **both** delegation modes. The [example backend](backend.md#independent-example) can provide a standalone starting point.
3. In Connections, link a calling account and verify a **different receiving account**. Telegram requires your application API ID/hash before QR or phone login. WhatsApp requires the private patched WaCalls sidecar. Follow the [account setup guide](console.md).
4. Choose voice, conversation behavior and delegation mode. Set call-duration and daily Live limits, then enable calling. Readiness requires a bound recipient and an available platform adapter; account login alone does not establish audio readiness.

Credentials are write-only in management responses. Use separate control, backend-request, event-signing and WaCalls media secrets. Keep the deployment/data directories, exported records and backups private.

## Voice and conversation

All fields below are under `live` in the deployment file or `settings.live` in a managed update.

| Field | Default | Meaning |
| --- | --- | --- |
| `model` | `gpt-live-1` | Supported voice model; fixed for this release |
| `voice` | `marin` | Built-in voice name; searchable suggestions and custom names are available |
| `custom_voice_id` | empty | Optional existing `voice_…` resource; overrides the built-in voice when set |
| `language` | `en` | Preferred spoken language; a prompt preference, not a locale restriction |
| `instructions` | empty | Additional voice behavior: personality, pace, brevity, pronunciation or conversational style; up to 16,000 characters |
| `greeting_enabled` | `true` | Request an immediate opening after fresh backend context arrives; when false, wait for the caller to speak |
| `delegation` | `client` | External backend or OpenAI-managed `responses`; one mode per call |

VoxDock supplies baseline instructions for AI identification, business-context handling and truthful reporting of tool outcomes. Voice instructions are added to these. The backend controls the call's purpose and verified facts; do not put changing task state or secrets into static instructions.

Voice/model catalogs are suggestions, not an account-access check. Custom voice resources must already exist and be available to the OpenAI project. Creating or uploading custom voices is outside this console. Unsupported model/voice combinations can be rejected by the provider when a call starts.

## Delegation and tools

| Mode | Executes reasoning and tools | Configuration | Audit |
| --- | --- | --- | --- |
| `client` | Your HTTP backend, including an agent or CLI you operate | Backend URL/credentials; model and tools belong to that backend | Correlated durable receipts and asynchronous result callbacks |
| `responses` | OpenAI-managed Responses through the Live session | `live.responses` fields below | Bounded response text, terminal outcome and source links retained in the call record |

In **client mode**, Responses settings do not affect execution. Configure browsing, custom tools, model selection and execution permissions in your backend. VoxDock does not register arbitrary function schemas that it cannot execute. The bundled example's OpenAI forwarding mode provides text assistance only; it has no browsing, shell or project tools.

In **Responses mode**, the external backend still provides context and receives call events, but the bridge does not send it execution delegations. Live sends managed response output back into the conversation itself; VoxDock records that result without appending duplicate speech. A completed model response is not independent proof that an external task succeeded.

| Field under `live.responses` | Default | Supported values or behavior |
| --- | --- | --- |
| `model` | `gpt-5.6-sol` | Delegated model ID; account/model compatibility is checked by the provider |
| `instructions` | empty | Instructions for the reasoning model, separate from the speaking voice; up to 16,000 characters |
| `reasoning_effort` | `low` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; support varies by model |
| `max_output_tokens` | `1024` | 16–16,384; includes reasoning tokens where applicable |
| `service_tier` | `auto` | `auto`, `default`, `flex`, `priority`; availability varies by project/model |
| `verbosity` | `low` | `low`, `medium`, `high` |
| `web_search` | `false` | Register the managed web-search tool |
| `tool_choice` | `auto` | `auto`, `required`, `none`; `required` needs web search enabled |
| `parallel_tool_calls` | `true` | Allow parallel tool calls when the provider supports them |

Enabling web search makes it available; `auto` lets the model decide whether to use it, `required` requests tool use and `none` disables tool use for that response. Live's supported web-search shape is `{ "type": "web_search" }`; domain filters and search-context-size settings from other APIs are not accepted here. Provider token/tool charges are additional to Live audio usage; the daily Live-seconds ledger is **not** a token or currency budget.

Example application settings fragment (merge into a full configuration):

```json
{
  "live": {
    "voice": "marin",
    "language": "zh-CN",
    "greeting_enabled": true,
    "instructions": "Speak clearly and keep status updates brief.",
    "delegation": "responses",
    "responses": {
      "model": "gpt-5.6-sol",
      "instructions": "Use reliable sources for current facts and cite them.",
      "reasoning_effort": "low",
      "max_output_tokens": 1024,
      "service_tier": "auto",
      "verbosity": "low",
      "web_search": true,
      "tool_choice": "auto",
      "parallel_tool_calls": true
    }
  }
}
```

These settings apply to subsequent calls after a successful idle-time update. The console does not mutate a live call's model or delegation mode.

## Calling and retention

| Setting | Default | Range or behavior |
| --- | --- | --- |
| `calling.enabled` | `false` | Enables admission when the configured platform/target is ready |
| `calling.max_call_seconds` | `600` | 1–3,600; includes a best-effort spoken warning before the hard limit |
| `calling.daily_live_seconds` | `1200` | 1–86,400; settled, reserved and unknown usage affect admission |
| `calling.ring_timeout_seconds` | `30` | 1–120 |
| `calling.max_request_ttl_seconds` | `300` | 1–3,600; outbound requests require an explicit expiry |
| `records.transcript_retention_days` | `7` | 0–30; zero disables transcript retention |
| `records.metadata_retention_days` | `30` | 1–365; call/result records and delivery metadata |
| `backend.ack_timeout_ms` | `3000` | 100–30,000; timeout does not prove business rejection |

One active call and zero automatic redials are fixed limits. At most one receiving target per platform is supported. Explicit pause/resume is an operator maintenance control, not a required everyday start/stop cycle. Run offline `cleanup` under the documented process-lock rules to remove expired records; exports, backups and the independent backend database have their own lifetimes. See [operations](operations.md).

## Deployment-owned settings

These belong in the deployment JSON and require restarting the service:

- `service.listen` (default `127.0.0.1:8787`) and `service.data_dir` (default `./data`). Non-loopback listeners require a control token.
- `security.control_token_file`, initial secret-file references, and the private WaCalls `endpoint`/`media_token_file`.
- `console.enabled`, exact `console.public_origin`, and `console.trusted_proxy_addresses`. Trust only explicit proxy IPs that supply the real client address.
- `timezone` (default `UTC`). An existing usage ledger cannot silently change timezones.
- `events.retry_deadline_hours` (default 24; 1–168) and `logging.level` (`debug`, `info`, `warn`, `error`, `silent`; default `info`).

Console credentials and **remote management access** are managed separately under Settings → Console account. Disabling remote management gates configuration, account and connection routes for both browser and bearer clients; it does not remove call/audit access. The setting relies on correctly configured trusted proxies. Local recovery requires stopping the writer; see [console account](console-account.md).

## Deliberate capability boundaries

VoxDock uses the **Live** primary WebSocket protocol, not the Realtime voice-turn API. It does not expose undocumented temperature, VAD or interrupt-threshold knobs. Conversational behavior is configured through instructions.

`live.store` and `records.raw_audio` stay `false`. Provider recording/download/fork features are not offered because this release does not implement their storage, consent, retention or restore workflow. No raw audio is written by VoxDock. This does not assert zero provider retention. Session history and long-term memory belong to the backend context contract; there is no static console transcript editor or cross-device memory store.

Live PCM is fixed to 24 kHz for Telegram and 16 kHz for WhatsApp, with the platform conversion handled by the bridge. Audio buffers, correlation and finalization are described in [Live/audio](live.md). The transport does not reconnect or replay a failed session automatically.

## CLI and API updates

```sh
pnpm voxdock settings options --config ./local/voxdock.config.json
pnpm voxdock configuration --config ./local/voxdock.config.json
pnpm voxdock configuration --config ./local/voxdock.config.json --file ./local/configuration-update.json
```

The private update file is a complete `{ "expected_revision": 3, "settings": { ... }, "secrets": { ... } }` object. Copy the current `settings` from GET, edit intended fields and use its current revision. Omit `secrets` to retain existing values; include only replacements such as `live_api_key`, `backend_request_token`, `backend_event_signing_key` or `telegram_api_hash`. Do not commit this file. Omitted new Live preferences receive defaults for older clients; use a fresh GET to preserve settings introduced by newer releases.

The bearer endpoints are `GET/PUT /v1/console/settings/configuration` and `GET /v1/console/settings/options`. The browser uses equivalent `/admin/v1` routes with cookie, Origin and CSRF checks. A stale revision returns 409. Invalid or unknown configuration fields return 400. See [API reference](api.md) and [console routes](console.md#api-and-cli-parity).

Generate the machine-readable deployment and contract schemas with `pnpm schemas`. Runtime cross-field checks remain authoritative. Official provider references: [Live delegation](https://developers.openai.com/api/docs/guides/live-delegation), [session management](https://developers.openai.com/api/docs/guides/live-conversations) and [Live API](https://developers.openai.com/api/reference/typescript/resources/live/methods/create).
