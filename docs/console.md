# Operator console

VoxDock includes a responsive web console at `/console/`. It uses the same bridge process and SQLite ledger as the CLI. It does not connect the browser to WaCalls or expose the control token.

## Available views

- **Overview:** last 1, 7 or 30 local calendar days; call counts, observed connection rate, settled Live time, delegation outcomes, daily trends, platform distribution, today's budget, active calls and calls requiring review.
- **Calls:** server-filtered, cursor-paginated records; lifecycle events, latest delegation results, retained transcript fragments and JSON/HTML export. An end request is followed by polling the recorded state; acceptance is not proof of termination.
- **Connections:** enabled channels, runtime readiness and configured target references. Disabled and unavailable are distinct states. The page does not initiate a platform login.
- **Settings:** effective file configuration and retention limits, with authenticated pause/resume controls. Runtime settings remain file-managed; there is no browser save operation.

Platform pairing, managed configuration, scoped Agent credentials and MCP are separate work. The existing fixed-target `POST /v1/calls` and CLI `call` remain available for authorized integrations. Task routing and long-term memory stay in the business backend.

## Enable the console

Build the frontend, generate an independent administrator password and write its hash. Use a private input file so the password does not enter shell history or process arguments:

```sh
pnpm build
(umask 077; openssl rand -base64 24 > ./local/console-password)
pnpm voxdock console password \
  --password-file ./local/console-password \
  --out ./local/admin.hash
```

Keep the generated password in your password manager. The bridge reads only `admin.hash`; it does not need the plaintext input file. Add the following to the initialized configuration:

```json
{
  "console": {
    "enabled": true,
    "public_origin": "http://127.0.0.1:8787",
    "password_hash_file": "./admin.hash"
  }
}
```

This is a configuration fragment, not a replacement for the existing configuration. Restart the service and open `http://127.0.0.1:8787/console/`. Remote instances must use an exact HTTPS origin such as `https://voice.example.com`, without a trailing slash, path, query or credentials. Forward the entire host to the bridge; no additional platform or media port is needed for the console. Keep WaCalls private.

To rotate a password, generate a **new** hash file, change the reference and restart. Existing files are never silently overwritten. Restart invalidates all web sessions. Console login is independent of API, backend and platform credentials.

The local Docker build includes the frontend. Leave `console.enabled` false to run headless. For frontend development, build once, run the bridge on loopback port 8787, set the console origin to `http://127.0.0.1:5173`, then run `pnpm --filter @voxdock/console dev`. Vite proxies `/admin` to the local bridge.

## API and CLI parity

Authenticated browser calls use `/admin/v1`; operator CLI projections use `/v1/console` with the existing bearer token. Both route groups invoke the same backend service and store queries. The original `/v1/calls` contracts remain compatible.

| Resource, relative to either prefix | Behavior |
| --- | --- |
| `GET /overview?days=1\|7\|30` | Calendar-window totals and chart series |
| `GET /calls` | Filters: channel, direction, state, from/to UTC timestamps; limit 1–100 and opaque cursor |
| `GET /calls/{id}` | Summary, events and latest result per current delegation context |
| `GET /calls/{id}/transcripts` | Insertion-order cursor, limit 1–200, retention availability |
| `GET /calls/{id}/export` | `format=json\|html`; redacted by default, `redact=false` explicitly includes private records |
| `GET /connections`, `GET /settings` | Effective status and a safe configuration projection |
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

Offline `resume` and `reconcile` retain their existing process-lock requirements. A console user cannot clear an uncertain outcome by clicking Resume.

## Measurement rules

All aggregation and eligibility rules execute on the server. The browser formats and plots the returned values and stores only transient interaction state.

- A connection means the bridge recorded a platform connection. It does not prove intelligible audio, task completion or a normal handset hangup.
- The connection rate divides connected **ended** calls by ended calls with known connection history. Active calls are excluded from this denominator. Connected-call counts can also include a currently connected call.
- Missing historical evidence is `null`, not zero. Existing records have unknown historical platform/source when no snapshot was captured; the current target configuration is not substituted for history.
- Call duration is the recorded interval from connection to the terminal transition. It is not measured speech time or billable provider usage. Manual reconciliation can extend that interval.
- Live seconds are separate **settled**, **reserved** and **unknown** ledger values. Reserved/unknown amounts reduce the admission budget and are not reported as measured consumption. The ledger assigns a reservation to its starting local day. No token or currency estimates are fabricated.
- A delegation contributes once, using its latest result for its current context revision. `accepted`, `working`, `needs_clarification` or no result remain pending; model text is not independent evidence of an external action.
- Transcript fragments preserve their partial/final flags, session identifiers and retention state. No raw audio is recorded. Full detail/export may contain private conversation text; redacted exports omit that text and identifying references.

Changing the configured timezone when a usage ledger already uses another timezone is rejected for usage reporting/admission. Keep the existing timezone until an explicit ledger migration is available.

Database schema 2 adds durable call facts and monotonic transcript cursors. Migration preserves existing command identities, calls and records. Facts survive event cleanup; migration backfills only facts supported by retained history. Before upgrading, take a consistent private copy of the configuration and complete data directories using the [restore procedure](install.md#upgrade-restore-and-rollback). Older binaries cannot open the upgraded database; rollback requires the matching backup.

## Authentication and implementation

Administrator passwords use salted scrypt hashes. Fastify secure-session issues an encrypted, HttpOnly, SameSite=Strict cookie with an eight-hour expiry; a bounded server-side session registry permits logout revocation. Login is rate-limited, and authenticated mutations require the configured Origin and a CSRF token. Sessions disappear on restart. There is one operator, not a multi-user permission system.

The frontend stores neither a bearer token nor transcripts in local storage. Private responses use `no-store`; React renders text without HTML injection, and audit HTML escapes source content. The browser never receives platform sessions, QR codes, passwords, secret values or arbitrary filesystem access.

The UI reuses [Mantine](https://mantine.dev/guides/vite/) AppShell, inputs, tables, dialogs and charts, with React Query for request state and React Router for navigation. This avoids maintaining a private foundation of copied components. The alternatives reviewed were [shadcn/ui](https://ui.shadcn.com/docs), which gives more source-level control with more component maintenance, and [Ant Design](https://ant.design/components/overview/), whose larger administration conventions are unnecessary for this scope. Dependency versions are pinned in the workspace lockfile. The Fastify server owns authentication, validation, query projections and call controls; no separate frontend backend or browser call coordinator is introduced.
