# Backend integration

`@voxdock/backend` connects a bridge to one configured HTTP(S) base URL. It never follows redirects or accepts a callback URL from a model. Request bodies use the published schemas; responses are capped at 64 KiB and have a bounded timeout. Authentication uses a dedicated bearer token. Transport errors and timeouts leave business acceptance unknown: do not tell the caller that a job was rejected or completed merely because a request failed.

Create `BackendClient({ baseUrl, requestToken, eventSigningKey, timeoutMs?, fetch?, now? })`. The injected fetch and clock support offline tests. Call `context(call, principalRef, 'before_dial')` before reserving platform side effects, then call it again with `before_greeting` immediately before speaking. The response envelope is `{ call_id, context_ref, context }`, where `context` follows `BackendContext`. Both identifiers must match. An obsolete context means do not start the intended call or deliver its stale opening. The client returns the flag; the coordinator performs cancellation or a factual fallback.

`delegate(payload)` sends a durable delegation identity and context revision. The result must identify the same call, delegation and context revision. The result revision independently increases for business updates. Retrying a timed-out delegation must reuse its identity and revision; the backend must persist acceptance before returning a receipt.

`deliverEvent(event)` signs `timestamp + '.' + raw JSON bytes` with HMAC-SHA256. Headers are `x-voxdock-timestamp` (Unix seconds) and `x-voxdock-signature` (lowercase hexadecimal). Each retry uses the same event and a fresh timestamp. The backend verifies signatures with constant-time comparison and a five-minute clock window. Its event ID ledger acknowledges identical replay and rejects changed content. Keep host clocks synchronized.

`OutboxWorker(client, store, deadlineHours?).runOnce(limit?)` delivers due core events and acknowledges or schedules their retry. Calls are serialized across worker instances in one process. Deploy one bridge process per SQLite database; this worker is not a multiprocess lease implementation. It never starts a phone call. The application owns scheduling and shutdown.

## Independent example

The example is a simulation, not a coding agent or a business executor. It persists accepted `example_job` receipts in SQLite; jobs survive a backend restart and call termination. It does not execute Codex or automatically complete jobs. `GET /simulation/jobs` shows their durable status. Context references beginning with `obsolete:` exercise stale-notification handling. Async completion callbacks are not implemented in this example.

Run from the workspace with `pnpm --filter @voxdock/example-backend start`. It binds only `127.0.0.1:8090`. Set `BACKEND_REQUEST_TOKEN_FILE` and `BACKEND_EVENT_SIGNING_KEY_FILE` to secret files, or provide `BACKEND_REQUEST_TOKEN` and `BACKEND_EVENT_SIGNING_KEY` through the environment. File values take precedence. Optional settings are `EXAMPLE_BACKEND_PORT` and `EXAMPLE_BACKEND_DATABASE`. Secrets and request payloads are not logged. Use a service manager or secret store for production credentials.

The example exposes authenticated `POST /voice/v1/context`, `/voice/v1/delegations`, `/voice/v1/events`, and `GET /simulation/jobs`. Event signatures cover the unmodified request body. Call state merges by increasing revision; out-of-order events cannot undo later state. Received event bodies and delegation transcripts are hashed for deduplication but not stored as plaintext. SQLite uses WAL and full synchronization; apply the same local-filesystem and consistent-backup rules as the bridge.
