# Control and integration API

The service requires `Authorization: Bearer <control-token>` for every route except `/healthz`. Keep it on a trusted private network. Credentials come from operator-managed files; call requests select configured target references and cannot supply recipients or backend URLs.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/capabilities`, `/v1/targets` | Configuration and adapter readiness |
| `POST /v1/calls` | Admit a call; requires an `Idempotency-Key` and a fixed expiry |
| `GET /v1/calls`, `/v1/calls/:call_id` | Inspect call states |
| `POST /v1/calls/:call_id/end` | Request termination; inspect subsequent state |
| `POST /v1/control/pause` | Persist a pause for new calls |
| `GET /v1/events?after=0&limit=100` | Read ordered durable events |
| `GET /v1/calls/:call_id/record` | Call, transcript availability, delegation/result records and usage |
| `POST /v1/calls/:call_id/delegations/:delegation_id/results` | Deliver a correlated asynchronous backend result |
| `GET /v1/openapi.json` | Export the running control API definition |

The authenticated running API exposes OpenAPI. `pnpm schemas` exports the configuration and shared contract JSON Schemas to `dist/schemas`; the local-build image includes them at `/app/dist/schemas`. Schemas describe syntax. Configuration cross-field invariants, known targets, valid timestamps, revisions and state transitions are also checked by the application.

Retry the original call command with the same idempotency key and identical body after an unknown HTTP outcome. Reusing a key with different content conflicts. A call accepted by HTTP has not necessarily dialed or connected.

Backend results include both `context_revision` (the source conversation snapshot) and `revision` (the business result sequence). An old-context result may be recorded without being spoken. `playback_status:eligible` is a routing decision, not evidence of playback or an external action. Result retries reuse the original `result_id`; the bridge does not repeat speech on a duplicate result.

See [backend integration](backend.md), [runtime](runtime.md) and [recovery](state-and-recovery.md) for the corresponding behavior. API tokens, audit exports and transcripts are private operator data.
