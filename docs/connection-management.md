# Console connection management

The authenticated console and bearer administrator API use the same connection service. The service reserves the runtime lifecycle for the entire login challenge, pauses call admission, and refuses parallel operations. Runtime acquisition must reject active or uncertain calls. Successful cleanup releases a temporary in-memory admission hold and restores availability automatically. Explicit maintenance pauses remain unchanged. Unconfirmed cleanup persists a recovery pause and keeps the manager blocked. Shutdown closes admission before draining every management flow; cancellation failures do not skip runtime cleanup.

Telegram login uses phone, code, and optional two-factor password callbacks. Challenges expire after three minutes (maximum five minutes), are single-use per step, and remain only in memory. The session is created exclusively with owner-only permissions inside the managed private directory. Signing in over an existing session is rejected. Disconnect removes the local session file; it does not revoke that device in Telegram's account settings. Cancellation aborts prompts and disconnects the authorization client before releasing the runtime.

WhatsApp management uses a fixed operator-configured private WaCalls origin and session identifier. The browser cannot select an origin or upstream route. The additional controlled patch provides status, connect, and disconnect for that session. Viewing status never creates or resets a session. Connect reuses a paired device; disconnect closes the connection and cancels pending QR pairing while retaining paired device storage. The explicit unlink operation signs out the server device and removes its local credentials so the next connect requires a fresh QR. The bridge disables this channel and receiving targets durably before requesting logout, retaining call history and stable target IDs. Pending/unknown logout cannot silently reactivate the old recipient. The unauthenticated sidecar endpoints must stay private.

All challenge responses use `Cache-Control: no-store`. QR content is returned only by an authenticated challenge response, never logged by the bridge or printed by the patched sidecar. Phone numbers, codes, passwords, and QR payloads must not be included in HTTP request logs or persisted in audit events. Provider errors are replaced with fixed messages.

## Endpoints relative to the administrator prefix

- `POST /connections/telegram/login` with `{phone}`.
- `POST /connections/whatsapp/connect` with `{}`.
- `POST /connections/whatsapp/unlink` with `{}`; explicit sign-out/reset, independent of disconnect.
- `GET /connections/flows/:id` returns `ConnectionFlow`.
- `POST /connections/flows/:id/refresh` with `{}` refreshes an active WhatsApp QR attempt under the same management lease. It preserves an account that has completed pairing and rejects Telegram or expired flows.
- `POST /connections/flows/:id/code` with `{code}`.
- `POST /connections/flows/:id/password` with `{password}`.
- `POST /connections/flows/:id/cancel` with `{}`.
- `POST /connections/:channel/disconnect` with `{}`.
- WhatsApp receiving-number setup, verification and confirmation routes are documented in the [console API](console.md#api-and-cli-parity).
- `POST /connections/telegram/target` with `{peer_id, enabled}` saves the manual numeric Telegram target.

The flow has `id`, `channel`, `state`, `expires_at`, optional `qr`, optional `qr_expires_at`, and optional sanitized `error`. The QR expiry is separate from the overall challenge deadline. Terminal states are connected, cancelled, expired, or failed. Polling a flow never starts a login. Restart loses pending challenges; calling remains controlled by the durable pause and runtime reconciliation rules.

## Validation and limits

For a saved WhatsApp account, start WaCalls and wait for the configured session to be paired and open before starting the bridge. Container health alone does not establish account readiness. Runtime initialization checks once; a later platform reconnect does not automatically recreate the driver. Recover while paused and with no active or uncertain call by restarting the bridge after checking the account, or by saving and applying the reviewed configuration in Settings. Normal management recovery releases its temporary hold automatically; end an explicit maintenance pause in Settings only after readiness is restored.

Fake Telegram callbacks cover code/2FA, exclusive lease ownership, cancellation, and stale submissions. Fake sidecar requests cover fixed routing, QR expiry, existing pairing reuse, and uncertain cleanup. Fastify injection covers strict request bodies and non-cacheable results. Controlled Go tests cover read-only status, preserved paired devices, and disconnect state. No real account or paid Live acceptance is claimed. Browser refresh does not restore a pending challenge identifier; it expires automatically.

## Cancellation and liveness correction

A connect request can finish after cancellation is requested. Cancellation now drains its pending connect request before disconnecting. A timed-out or failed mutation has an unknown outcome, so the lifecycle lease is released as unsafe and calling remains blocked. Shutdown also waits for a terminal flow's pending lifecycle release. These cases have deterministic fake-transport regression tests.

Sidecar status reads have a three-second deadline; mutations have a ten-second deadline. All sidecar responses are limited to 64 KiB. Account-status reads are nonmutating and unknown status is reported disconnected. WhatsApp open status requires a currently connected and logged-in socket. Disconnect cancels and joins the QR worker before publishing the final disconnected state, preventing a late QR from reappearing. API errors use fixed codes suitable for frontend translation.

Refreshing QR clears the previous code immediately, renews the challenge deadline, and requests a fresh unpaired device attempt from the sidecar. It does not unlink an established account. A credential write already in progress is allowed to finish; status polling reports the outcome. Cancellation drains any pending refresh before disconnecting. Responses from earlier polls cannot replace the refreshed code. Expired QR content and transient status failures clear the displayed code, and a later successful status clears the transient error. Provider timeout, outdated-client and pairing failures end the flow with a fixed error category; unknown credential cleanup retains the recovery pause.

## Guided WhatsApp receiving account

QR login and receiving-number verification are separate flows. The QR flow must reach its own terminal state before its lease is released and verification can start; an account-status response alone does not complete it. The server generates internal application references and exposes phone numbers for review. A random single-use code or an incoming call identifies one frozen candidate; the operator must explicitly confirm that number within the displayed window. Existing target identifiers and principal references survive replacement, and the old target stays committed until verified runtime installation succeeds. Self-account candidates are rejected.

The [sidecar observer](whatsapp-target-pairing.md) never stores general message content or accepts a verification call. It uses the provider's canonical phone mapping, not a browser-supplied address. Pending flows are ephemeral; refresh/navigation does not restore their IDs. They expire automatically, and uncertain cancellation leaves calling blocked for recovery. Full handset QR/message/call acceptance still requires testing.

## Unlink transaction

The global calling preference stays enabled while its last channel or target is unlinked. This is a valid unconfigured state: the console reports not ready, no voice adapter is created, and call admission and resume reject it. Fresh account authorization alone does not restore the disabled target. Confirming a verified receiving number restores availability without changing the operator's calling preference or maintenance pause.

Runtime admission stays held across disabling the WhatsApp configuration and the provider mutation. A configuration-install failure prevents logout; an unconfirmed provider result leaves the disabled revision committed and persists recovery pause. Shutdown drains this mutation before closing shared storage. The sidecar records per-session unlink recovery, distinguishes remote sign-out acknowledgement from local deletion, and rejects new pairing until cleanup is complete. It does not erase other accounts or VoxDock call records. Controlled status exposes pending cleanup even if the device ID is already absent.
