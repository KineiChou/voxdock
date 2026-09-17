# Console connection management

The authenticated console and bearer administrator API use the same connection service. The service reserves the runtime lifecycle for the entire login challenge, pauses call admission, and refuses parallel operations. Runtime acquisition must reject active or uncertain calls. Successful cleanup releases the lease while admission stays paused; the operator explicitly resumes. Unconfirmed cleanup keeps the manager blocked.

Telegram login uses phone, code, and optional two-factor password callbacks. Challenges expire after three minutes (maximum five minutes), are single-use per step, and remain only in memory. The session is created exclusively with owner-only permissions inside the managed private directory. Signing in over an existing session is rejected. Disconnect removes the local session file; it does not revoke that device in Telegram's account settings. Cancellation aborts prompts and disconnects the authorization client before releasing the runtime.

WhatsApp management uses a fixed operator-configured private WaCalls origin and session identifier. The browser cannot select an origin or upstream route. The additional controlled patch provides status, connect, and disconnect for that session. Viewing status never creates or resets a session. Connect reuses a paired device; disconnect closes the connection and cancels pending QR pairing while retaining paired device storage. Switching the paired WhatsApp account still requires an operator to revoke its linked device. The unauthenticated sidecar endpoints must stay private.

All challenge responses use `Cache-Control: no-store`. QR content is returned only by an authenticated challenge response, never logged by the bridge or printed by the patched sidecar. Phone numbers, codes, passwords, and QR payloads must not be included in HTTP request logs or persisted in audit events. Provider errors are replaced with fixed messages.

## Endpoints relative to the administrator prefix

- `POST /connections/telegram/login` with `{phone}`.
- `POST /connections/whatsapp/connect` with `{}`.
- `GET /connections/flows/:id` returns `ConnectionFlow`.
- `POST /connections/flows/:id/code` with `{code}`.
- `POST /connections/flows/:id/password` with `{password}`.
- `POST /connections/flows/:id/cancel` with `{}`.
- `POST /connections/:channel/disconnect` with `{}`.

The flow has `id`, `channel`, `state`, `expires_at`, optional `qr`, and optional sanitized `error`. Terminal states are connected, cancelled, expired, or failed. Polling a flow never starts a login. Restart loses pending challenges; calling remains controlled by the durable pause and runtime reconciliation rules.

## Validation and limits

For a saved WhatsApp account, start WaCalls and wait for the configured session to be paired and open before starting the bridge. Container health alone does not establish account readiness. Runtime initialization checks once; a later platform reconnect does not automatically recreate the driver. Recover while paused and with no active or uncertain call by restarting the bridge after checking the account, or by saving and applying the reviewed configuration in Settings. Verify readiness before explicitly resuming.

Fake Telegram callbacks cover code/2FA, exclusive lease ownership, cancellation, and stale submissions. Fake sidecar requests cover fixed routing, QR expiry, existing pairing reuse, and uncertain cleanup. Fastify injection covers strict request bodies and non-cacheable results. Controlled Go tests cover read-only status, preserved paired devices, and disconnect state. No real account or paid Live acceptance is claimed. Browser refresh does not restore a pending challenge identifier; it expires automatically.

## Cancellation and liveness correction

A connect request can finish after cancellation is requested. Cancellation now drains its pending connect request before disconnecting. A timed-out or failed mutation has an unknown outcome, so the lifecycle lease is released as unsafe and calling remains blocked. Shutdown also waits for a terminal flow's pending lifecycle release. These cases have deterministic fake-transport regression tests.

Sidecar status reads have a three-second deadline; mutations have a ten-second deadline. All sidecar responses are limited to 64 KiB. Account-status reads are nonmutating and unknown status is reported disconnected. WhatsApp open status requires a currently connected and logged-in socket. Disconnect cancels and joins the QR worker before publishing the final disconnected state, preventing a late QR from reappearing. API errors use fixed codes suitable for frontend translation.
