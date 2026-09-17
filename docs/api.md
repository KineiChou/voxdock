# Control and integration API

The `/v1/*` service requires `Authorization: Bearer <control-token>`; `/healthz` is public. Keep the control API on a trusted private network or behind your authenticated HTTPS deployment. The optional [operator console](console.md) serves public login assets at `/console/` and uses separate authenticated cookie sessions at `/admin/v1/*`. Initial console credentials are generated into a private bootstrap file; managed credentials remain private. Call requests select configured target references and cannot supply recipients or backend URLs.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/capabilities`, `/v1/targets` | Configuration and adapter readiness |
| `POST /v1/calls` | Admit a call; requires an `Idempotency-Key` and a fixed expiry |
| `GET /v1/calls`, `/v1/calls/:call_id` | Inspect call states |
| `POST /v1/calls/:call_id/end` | Request termination; inspect subsequent state |
| `POST /v1/control/pause` | Persist a pause for new calls |
| `POST /v1/control/resume` | Resume only when enabled, idle and ready; unresolved calls remain blocked |
| `/v1/console/*` | Dashboard, records, managed settings and pairing; same backend as browser routes, with bearer authentication; see [console API](console.md#api-and-cli-parity) |
| `GET /v1/events?after=0&limit=100` | Read ordered durable events |
| `GET /v1/calls/:call_id/record` | Call, transcript availability, delegation/result records and usage |
| `POST /v1/calls/:call_id/delegations/:delegation_id/results` | Deliver a correlated asynchronous backend result |
| `GET /v1/openapi.json` | Export the running control API definition |

The authenticated running API exposes OpenAPI. `pnpm schemas` exports the configuration and shared contract JSON Schemas to `dist/schemas`; the local-build image includes them at `/app/dist/schemas`. Schemas describe syntax. Configuration cross-field invariants, known targets, valid timestamps, revisions and state transitions are also checked by the application.

Retry the original call command with the same idempotency key and identical body after an unknown HTTP outcome. Reusing a key with different content conflicts. A call accepted by HTTP has not necessarily dialed or connected.

An uncertain call requires reconciliation. An end request cannot erase that state when the runtime lacks an active call coordinator; it returns `409 reconciliation_required` and leaves the call visible for review.

Backend results include both `context_revision` (the source conversation snapshot) and `revision` (the business result sequence). An old-context result may be recorded without being spoken. `playback_status:eligible` is a routing decision, not evidence of playback or an external action. Result retries reuse the original `result_id`; the bridge does not repeat speech on a duplicate result.

See [backend integration](backend.md), [runtime](runtime.md) and [recovery](state-and-recovery.md) for the corresponding behavior. API tokens, audit exports and transcripts are private operator data.

## Managed settings and connections

Both `/admin/v1` (cookie plus Origin/CSRF for mutations) and `/v1/console` (bearer) expose `GET/PUT /settings/configuration` and the connection-flow routes. The managed configuration PUT requires `{ expected_revision, settings, secrets? }`; GET returns `{ revision, settings, credentials, deployment, applying }`. Secret values are never returned. Application fields and fixed targets are editable; timezone, WhatsApp endpoint and other deployment fields remain deployment-owned.

`GET /settings/options` on both prefixes returns `{ voices, languages, allow_custom_voice, allow_custom_language }`; each choice has a `value` and display `label`. This backend-owned catalog is also available through `voxdock settings options`. It contains suggestions, preserves custom configuration values, makes no provider request, and follows the same authentication, no-store and remote-management rules as other settings routes.

Revision conflicts, active/uncertain calls and concurrent management return 409. Validation/missing credentials return 400. Apply temporarily stops admission and replaces the runtime only while idle; successful changes or confirmed rollback restore availability automatically while preserving explicit maintenance pauses. Failure retains the previous committed revision. Uncertain cleanup persists a recovery pause and blocks further replacement.

Connection flows report `starting`, `code_required`, `password_required`, `qr_required`, `connected`, `cancelled`, `expired` or `failed`. A QR is ephemeral and appears only in `qr_required`. The server chooses the configured platform account and upstream service; clients cannot supply arbitrary service URLs. Calls are never fabricated to test pairing. WhatsApp requires the matching controlled sidecar patches. Its separate receiving-number flow exposes waiting/candidate/completed/cancelled/expired/failed, a bounded expiry and an opaque candidate ID. Confirm commits only the provider-observed number after explicit operator review. The [console API](console.md#api-and-cli-parity) lists both browser and bearer routes, with CLI equivalents.

`POST /connections/flows/:id/refresh {}` refreshes an active WhatsApp QR flow on either administrator prefix. It returns the same flow ID and a renewed challenge deadline; poll for the new QR. The optional `qr_expires_at` is the individual code's expiry. Refresh keeps the management lease, preserves a successfully linked account, and cannot select an upstream session or recipient. CLI: `voxdock connection refresh --flow ID`.

Disabling remote management applies to Settings/Connections/account paths for cookie and bearer clients alike. Calls, audit views and normal call controls remain available. Trusted proxy configuration and offline account recovery are described in [console setup](console.md#enable-the-console).

`POST /connections/whatsapp/unlink {}` on either administrator prefix disables the channel/recipient bindings before confirmed server-device logout. It returns `{ unlinked: true }`, retains call history and stable target identities, and requires fresh QR plus recipient verification for reuse. On an unknown provider outcome, the disabled configuration remains committed and calling stays paused; this irreversible sign-out is not rolled back as if no external action occurred. `disconnect` continues to retain the paired device.
