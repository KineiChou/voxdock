# Operator console

VoxDock includes a responsive web console at `/console/`. It uses the same bridge process and SQLite ledger as the CLI. It does not connect the browser to WaCalls or expose the control token.

## Available views

- **Overview:** last 1, 7 or 30 local calendar days; call counts, observed connection rate, settled Live time, delegation outcomes, daily trends, platform distribution, today's budget, active calls and calls requiring review. The homepage displays service status; configured calling stays available without a Start button.
- **Calls:** server-filtered, cursor-paginated records; lifecycle events, latest delegation results, server-grouped conversation text and JSON/HTML export. An end request is followed by polling the recorded state; acceptance is not proof of termination.
- **Connections:** account authentication and calling readiness, Telegram credentials and phone/code/two-step verification, an advanced manual Telegram receiving account, and guided WhatsApp setup. WhatsApp setup links the calling account with a QR code, then verifies a separate receiving account by a message code or incoming call and explicit number confirmation. Pairing can be cancelled and accounts disconnected. An authenticated account can remain disabled for calls.
- **Settings:** save and apply calling limits, Live voice/language/credentials, agent backend and retention; change administrator credentials and remote-management access. Explicit maintenance pause/end-maintenance controls live here, with eligibility supplied by the backend.

Scoped Agent credentials and MCP remain separate work. The existing fixed-target `POST /v1/calls` and CLI `call` remain available for authorized integrations. Task routing and long-term memory stay in the business backend.

## Enable the console

Build the frontend and enable the console in the deployment configuration:

```json
{
  "console": {
    "enabled": true,
    "public_origin": "http://127.0.0.1:8787"
  }
}
```

This is a fragment, not a replacement configuration. Start the service and open `/console/`. On first startup, VoxDock creates username `admin` and a random password in the private `bootstrap-credentials.txt` file inside the configured data directory. Read it locally, sign in, and change credentials in Settings. Credential rotation removes the bootstrap file and invalidates existing sessions. Passwords must contain 12–256 characters; usernames use letters, digits, dots, underscores or hyphens and start with a letter or digit.

Existing installations with `console.password_hash_file` migrate to username `admin` and their existing password. After the account file exists, changing the legacy hash file does not rotate the account; use Settings or offline recovery. Console credentials are independent of API, backend and platform credentials.

For recovery, stop the service, place a new password in a private file, then run:

```sh
pnpm voxdock console recover --config ./local/voxdock.config.json \
  --username admin --password-file ./local/new-password --allow-remote true
```

Only the options being changed are required. Restart afterward. Recovery requires exclusive ownership of the data directory and never prints the password.

Remote instances require an exact HTTPS `public_origin`, without a path, query, credentials or trailing slash. Forward the whole host and keep WaCalls private. `allow_remote_management=false` restricts Settings, Connections and account management on both cookie and bearer routes; login, Overview, Calls and call controls remain usable. Local access includes loopback and private-network addresses. A reverse proxy must be listed by literal IP in `console.trusted_proxy_addresses` and **replace** `X-Forwarded-For` with exactly one original client IP. Forwarded headers from untrusted peers, missing trusted-proxy headers and address chains are not accepted as local management access.

## Apply settings and pair accounts

The deployment file owns the listener, public origin, trusted proxies, data paths, timezone and WhatsApp service endpoint/media credential. The managed configuration owns calling, Live, backend, retention, channel account settings and fixed targets. GET responses expose credential-presence flags only. Secret inputs are write-only replacements; leaving one blank retains the existing credential.

Save and apply validates the complete configuration and expected revision, rejects active or uncertain calls, temporarily blocks new calls, and serializes runtime replacement with pairing operations. The managed revision commits only after the replacement runtime starts. Successful application or confirmed rollback releases that temporary block automatically; any existing maintenance pause is preserved. Uncertain cleanup persists a recovery pause and keeps further management blocked. A revision conflict requires reloading saved settings and reviewing edits. Browser polling does not overwrite unsaved form values.

For Telegram, save the API ID/hash with the channel disabled, connect using the phone verification flow, then enable the channel and save the receiving account's numeric Telegram user ID in Advanced setup. VoxDock assigns internal account and target references; WhatsApp message/call verification is not implemented for Telegram. WhatsApp pairing requires a private WaCalls service built with all four current controlled patches; rebuild the sidecar image when upgrading this feature. An older image without `/api/voxdock/sessions/...` cannot provide this pairing flow. Choose **Configure WhatsApp**, then scan the displayed QR in WhatsApp Linked devices using the account that will call you. If it is already connected, setup goes straight to pairing the receiving account. From your separate receiving account, send the displayed code to the linked number or use the incoming-call alternative. Review the detected number and select **Confirm this number**; the existing target stays unchanged until confirmation. Closing the setup dialog cancels an active attempt; leaving the page keeps it armed until its displayed expiry. Confirmation saves the target and enables its WhatsApp channel; calling readiness then updates automatically. Global calling, Live credentials and the agent backend must still be configured in Settings. Verification calls are rejected without answering or starting Live; a rejected verification call is expected. The bridge never sends a pairing message or places a pairing call on your behalf. Pairing, account authentication and call readiness are separate states; none establishes a successful phone call. Timeouts/cancellation are reported by the backend, and uncertain cleanup blocks further changes.

**Start over or change the calling account:** open Configure WhatsApp and select **Unlink account** in the calling-account card. An inline confirmation explains the effect. VoxDock first disables this channel and its receiving targets, then signs out the server device and removes its local login. Call history and stable integration IDs are retained. The dialog returns to Link account; scan a new QR code and verify the receiving number again. The previous receiving number is shown only as history until verification enables it. Cancel an active QR/number-verification flow before unlinking; active or uncertain calls block the action.

A failed unlink is never reported as success. Calling stays paused and the receiving target disabled; review connectivity and restart VoxDock before retrying. If sign-out was acknowledged but local cleanup remains, **Finish unlinking** completes that cleanup without starting a new login. The separate CLI/API disconnect action still closes the network connection while preserving its login.

The local Docker build includes the frontend. Leave `console.enabled` false to run headless. For frontend development, build once, run the bridge on loopback port 8787, set the console origin to `http://127.0.0.1:5173`, then run `pnpm --filter @voxdock/console dev`. Vite proxies `/admin` to the local bridge.

## API and CLI parity

Authenticated browser calls use `/admin/v1`; operator CLI projections use `/v1/console` with the existing bearer token. Both route groups invoke the same backend service and store queries. The original `/v1/calls` contracts remain compatible.

| Resource, relative to either prefix | Behavior |
| --- | --- |
| `GET /overview?days=1\|7\|30` | Calendar-window totals and chart series |
| `GET /calls` | Filters: channel, direction, state, from/to UTC timestamps; limit 1–100 and opaque cursor |
| `GET /calls/{id}` | Summary, events and latest result per current delegation context |
| `GET /calls/{id}/conversation` | Server-grouped retained text with source partial/final flags; raw records unchanged |
| `GET /calls/{id}/transcripts` | Insertion-order cursor, limit 1–200, retention availability |
| `GET /calls/{id}/export` | `format=json\|html`; redacted by default, `redact=false` explicitly includes private records |
| `GET /connections`, `GET /settings` | Account authentication, readiness and applied status |
| `GET /settings/configuration` | Revision, editable settings, credential-presence flags and deployment fields |
| `PUT /settings/configuration` | Complete `{ expected_revision, settings, secrets? }`; validate and apply synchronously |
| `POST /connections/telegram/login` | `{ phone }`, international format |
| `POST /connections/whatsapp/connect` | `{}`; start QR pairing |
| `POST /connections/whatsapp/unlink` | `{}`; disable WhatsApp targets, sign out and clear its server login; returns `{ unlinked: true }` only after confirmation |
| `GET /connections/whatsapp/setup` | Linked/online state, pending unlink recovery, server and receiving numbers, and pairing availability |
| `POST /connections/whatsapp/target-pairings` | `{ method: "message" \| "call" }`; start a three-minute verification window |
| `GET /connections/whatsapp/target-pairings/{id}` | Expiry, challenge or observed candidate number |
| `POST /connections/whatsapp/target-pairings/{id}/confirm` | `{ candidate_id }`; confirm server-observed evidence and commit the target |
| `POST /connections/whatsapp/target-pairings/{id}/cancel` | `{}`; cancel without changing the saved target |
| `POST /connections/telegram/target` | `{ peer_id, enabled }`; manual numeric receiving account |
| `GET /connections/flows/{id}` | Current challenge or terminal state |
| `POST /connections/flows/{id}/code`, `/password` | `{ code }` or `{ password }` |
| `POST /connections/flows/{id}/cancel` | `{}`; cancel pairing |
| `POST /connections/{channel}/disconnect` | `{}`; disconnect configured account |
| `POST /control/pause` | Persistently stops new admission; existing calls continue |
| `POST /control/resume` | Requires enabled configuration, a ready configured target and no active or uncertain call |
| `POST /calls/{id}/end` | Shares the original call-ending service |

`from` is inclusive and `to` exclusive. Call cursors are bound to the active filters; changing a filter starts a new query. New calls do not shift an existing cursor like offset pagination would. A record's state can still change between requests.

```sh
pnpm voxdock overview --config ./local/voxdock.config.json --days 7
pnpm voxdock calls --config ./local/voxdock.config.json --channel whatsapp --limit 20
pnpm voxdock connections --config ./local/voxdock.config.json
pnpm voxdock settings --config ./local/voxdock.config.json
pnpm voxdock resume --online --config ./local/voxdock.config.json
```

`GET/PUT /admin/v1/account` are cookie-authenticated account routes. Updates require the current password and account revision; username/password rotation requires login again. Incorrect current passwords return 403 without revoking the session.

The CLI uses the same managed configuration and pairing services:

```sh
pnpm voxdock configuration --config ./local/voxdock.config.json
pnpm voxdock configuration --config ./local/voxdock.config.json --file ./local/configuration-update.json
pnpm voxdock connection connect --channel telegram --input-file ./local/phone.json --config ./local/voxdock.config.json
pnpm voxdock connection status --flow FLOW_ID --config ./local/voxdock.config.json
pnpm voxdock connection setup --channel whatsapp --config ./local/voxdock.config.json
pnpm voxdock target-pair start --method message --config ./local/voxdock.config.json
pnpm voxdock target-pair status --flow FLOW_ID --config ./local/voxdock.config.json
pnpm voxdock target-pair confirm --flow FLOW_ID --candidate CANDIDATE_ID --config ./local/voxdock.config.json
```

The private update file contains the PUT body, including `expected_revision` and the complete `settings`; optional `secrets` contains only replacements. Pairing input files contain `{ "phone": "+..." }`, `{ "code": "..." }` or `{ "password": "..." }` as appropriate. `connection code|password|cancel --flow ID` and `connection disconnect --channel telegram|whatsapp` complete the lifecycle. `target-pair cancel --flow ID` cancels receiving-number verification. `connection target --channel telegram --input-file FILE` accepts `{ "peer_id": "123456789", "enabled": true }`. The browser and CLI confirm only an opaque candidate ID; they cannot supply an arbitrary phone number as evidence. `connection unlink --channel whatsapp` performs the same confirmed sign-out; unlike `disconnect`, it requires a fresh QR and recipient verification afterward. Keep credential-bearing files and displayed verification codes private.

Offline `resume` and `reconcile` retain their existing process-lock requirements. A console user cannot clear an uncertain outcome by clicking Resume.

## Measurement rules

All aggregation and eligibility rules execute on the server. The browser formats and plots the returned values and stores only transient interaction state.

- A connection means the bridge recorded a platform connection. It does not prove intelligible audio, task completion or a normal handset hangup.
- The connection rate divides connected **ended** calls by ended calls with known connection history. Active calls are excluded from this denominator. Connected-call counts can also include a currently connected call.
- Missing historical evidence is `null`, not zero. Existing records have unknown historical platform/source when no snapshot was captured; the current target configuration is not substituted for history.
- Call duration is the recorded interval from connection to the terminal transition. It is not measured speech time or billable provider usage. Manual reconciliation can extend that interval.
- Live seconds are separate **settled**, **reserved** and **unknown** ledger values. Reserved/unknown amounts reduce the admission budget and are not reported as measured consumption. The ledger assigns a reservation to its starting local day. No token or currency estimates are fabricated.
- A delegation contributes once, using its latest result for its current context revision. `accepted`, `working`, `needs_clarification` or no result remain pending; model text is not independent evidence of an external action.
- Raw transcript fragments preserve their partial/final flags, session identifiers and retention state. The [conversation projection](console-conversation.md) joins adjacent text deltas on the server without manufacturing final turns. No raw audio is recorded. Full detail/export may contain private conversation text; redacted exports omit that text and identifying references.

Changing the configured timezone when a usage ledger already uses another timezone is rejected for usage reporting/admission. Keep the existing timezone until an explicit ledger migration is available.

Database schema 2 adds durable call facts and monotonic transcript cursors. Migration preserves existing command identities, calls and records. Facts survive event cleanup; migration backfills only facts supported by retained history. Before upgrading, take a consistent private copy of the configuration and complete data directories using the [restore procedure](install.md#upgrade-restore-and-rollback). Older binaries cannot open the upgraded database; rollback requires the matching backup.

## Authentication and implementation

Administrator passwords use salted scrypt hashes. Fastify secure-session issues an encrypted, HttpOnly, SameSite=Strict cookie with an eight-hour expiry; a bounded server-side session registry permits logout revocation. Login is rate-limited, and authenticated mutations require the configured Origin and a CSRF token. Sessions disappear on restart. There is one operator, not a multi-user permission system.

The frontend stores neither a bearer token nor transcripts in local storage. Private responses use `no-store`; React renders text without HTML injection, and audit HTML escapes source content. The browser receives ephemeral QR challenges only during authenticated pairing and accepts write-only credential input. It never reads back stored passwords, platform sessions, secret values or arbitrary files.

The UI reuses [Mantine](https://mantine.dev/guides/vite/) AppShell, inputs, tables, dialogs and charts, with React Query for request state and React Router for navigation. This avoids maintaining a private foundation of copied components. The alternatives reviewed were [shadcn/ui](https://ui.shadcn.com/docs), which gives more source-level control with more component maintenance, and [Ant Design](https://ant.design/components/overview/), whose larger administration conventions are unnecessary for this scope. Dependency versions are pinned in the workspace lockfile. The Fastify server owns authentication, validation, query projections and call controls; no separate frontend backend or browser call coordinator is introduced.
