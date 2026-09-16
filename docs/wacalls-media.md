# WaCalls server-side PCM adapter

This patch adds an authenticated binary WebSocket media adapter to [JotaDev66/WaCalls](https://github.com/JotaDev66/WaCalls) at commit `edeb31f0427aba896639db503153b777a405eccf`. It replaces the need for a browser media leg when used by VoxDock. It preserves WhatsApp packet construction, encryption, MLow and RTP algorithms. The patch also corrects termination acknowledgment handling as described below. The upstream browser bridge already converts mono 16 kHz PCM16 little-endian to/from the call manager's float32 callbacks; this adapter reuses the same converters. It does not relabel or resample audio.

## Build

Use Go 1.26.4, Git, and Bash. From the VoxDock repository:

```sh
scripts/wacalls/build.sh /tmp/wacalls-build
```

The destination must not exist. The script checks out the exact revision, checks/applies the reviewable patch, runs the upstream server tests including adapter tests, and builds host and Linux amd64 binaries. Artifacts include the upstream MIT license and source/patch/binary provenance. `WACALLS_SOURCE_DIR` may name a local clone for an offline build; its selected commit is still verified. Go module dependencies must already be cached for a fully offline build. Only the patch and upstream license are distributed in this repository, not a copied source tree. Use a trusted fixed FFmpeg build separately where another platform needs resampling.

## Configuration and contract

Set `WACALLS_MEDIA_SECRET_FILE` to a mounted regular file containing a secret of at least 32 bytes. A trailing newline is allowed; embedded newlines are refused. The file is capped at 4 KiB. Keep it readable only by the processes that require it. Missing configuration disables the added media routes; invalid configuration fails startup. Keep the original WaCalls REST interface on a private service network: this patch authenticates its new media endpoints and **does not add authentication to upstream REST routes**. Never publish port 8080 or proxy these routes publicly. Avoid debug logging of account pairing material from upstream.

1. After obtaining an active upstream session/call ID, send `POST /api/sessions/{sid}/calls/{id}/media-token` with `Authorization: Bearer <shared-secret>`. A successful response is `{ "token": "…", "expires_at": 1780000000000 }`, with a Unix millisecond expiration 30 seconds after issuance. Responses have `Cache-Control: no-store`.
2. Upgrade `GET /api/sessions/{sid}/calls/{id}/media` with `Authorization: Bearer <token>`. Query strings are refused. Each random token is bound to one session and call and consumed on its first validation attempt, including a mismatched call or failed upgrade. It cannot be retried; mint another token if connection establishment failed. Pending grants are capped at 128, with expired entries reclaimed on issuance.
3. The first server message is text: `{ "type": "media.ready", "format": "pcm_s16le", "sample_rate": 16000, "channels": 1 }`. It confirms adapter attachment, not that the remote phone answered or heard audio.
4. All subsequent application messages in both directions are binary raw PCM16LE. Input must contain complete samples, at least one sample, and at most 6,400 bytes (200 ms). Normal client pacing is one 640-byte frame every 20 ms, including silence. Five seconds without an input PCM frame terminates the media bridge; WebSocket ping alone does not satisfy this deadline. Upstream output callback boundaries can differ, so consume output in order by sample count.

A call admits one media sink across both browser and WebSocket paths. Second consumers cannot replace an active bridge. Do not attach the browser while VoxDock owns media. Outgoing PCM is bounded to eight frames, each no larger than 6,400 bytes; overflow closes the bridge instead of retaining an indefinite queue. Each socket write has a two-second deadline. Input is fed directly into the existing call manager without another audio queue. The sending application must maintain the sample clock, honor backpressure, and stop on disconnect.

Malformed input, transport failure, missing PCM or output overflow closes the socket and requests ending the associated call with a five-second context. A failed hangup emits the fixed message `media disconnect hangup unconfirmed`; the caller must treat the call outcome as uncertain and reconcile through the control interface. It must not blindly redial. The media sink remains occupied until upstream call removal, preventing reconnection to a call whose termination is unconfirmed. Call removal/server teardown closes the media socket. The patch writes no audio to disk and logs neither token nor media payload. Reverse proxies and callers must also avoid recording Authorization headers and token responses.

## Verification and boundaries

Local tests verify secret authorization, grant expiry/binding/replay/capacity, call existence, exclusive attachment, loopback binary PCM conversion, and malformed-frame cleanup. The registry now reads the current media sink under its lock before audio delivery; this avoids an unlocked bridge-pointer read while attaching media. Tests use synthetic PCM and no WhatsApp account. Real calling, phone interoperability, latency, continuous media quality, codec availability and failure recovery against WhatsApp remain unverified. Binary build success does not establish those capabilities.

The patch preserves upstream MIT attribution in `patches/wacalls/UPSTREAM-LICENSE` and includes that license alongside built binaries. Review upstream dependencies and applicable licenses before distributing a complete image.

On 2026-09-16, the clean-checkout build script completed with Go 1.26.4 on macOS arm64: `go test ./cmd/server` passed and both host and `CGO_ENABLED=0 GOOS=linux GOARCH=amd64` builds succeeded. `go test -race ./cmd/server -run '^TestMedia' -count=1` passed for the added media cases. Linux execution and real-account calls were not performed. The tests additionally verify output-queue overflow closes the socket and releases queued PCM.

## Termination evidence correction

The pinned upstream `EndCall` marks the call ended before launching a background terminate query, discards its result and lets the HTTP request context expire when its handler returns. The handler then removes the call and broadcasts `call-ended` regardless of the query result. Separately, the upstream socket query returns `(nil, nil)` on timeout. Together these paths can advertise success without evidence that a termination request was accepted. This defect was established by source inspection and reproduced with controlled socket tests, not a real WhatsApp account.

The patch stops local media and waits for a bounded, correlated `ack` with `class=call`, matching stanza ID and no error indication. A nil response, query error, cancellation or mismatched acknowledgment produces an unconfirmed result. The call remains reserved and later accept/transport/ack updates cannot restart its media. Repeated end requests do not resend a query after acknowledged or unconfirmed termination. A correlated remote termination event can resolve the retained call.

Successful `DELETE /api/sessions/{sid}/calls/{id}` now returns HTTP 200 with `{ "status": "ended", "termination": "acknowledged" }`, or `"remote"` if a peer event resolved it. `acknowledged` means the signaling request was acknowledged and local media was closed; **it does not prove the handset observed closure**. An unconfirmed outcome returns HTTP 502 `{ "error": "hangup_unconfirmed" }`; a missing active call returns 404 rather than inventing confirmation. The additive `termination` field on `call-ended` SSE/history distinguishes `acknowledged`, `remote`, and `unconfirmed`. Local rejection follows the upstream asynchronous path and is explicitly unconfirmed; it is not relabeled as a remote hangup.

The core tests cover waiting before signaling completion, valid acknowledgments, nil timeout responses, transport errors, wrong IDs, error acknowledgments, cancellation, idempotent repeat-end and a concurrent peer termination. An HTTP regression verifies unconfirmed state is not force-removed. Run `go test ./cmd/server ./internal/voip/call`; focused tests also passed with `-race`. Actual service acknowledgment shapes and handset termination still require real-call acceptance.

## Stored LID identity mapping

An incoming WhatsApp LID is not a phone number. The patch optionally adds `peer_phone_jid` to an `incoming` SSE event only when the authenticated account's existing `client.Store.LIDs.GetPNForLID` mapping resolves it to a valid phone JID. The original `peer` remains unchanged. This uses the pinned whatsmeow store API, not a network lookup or a conversion of LID digits. A one-second context bounds the local lookup; missing, invalid, errored or canceled results omit the field. Closed calls are not reannounced after lookup.

The Node admission layer must compare the mapped phone JID to its configured target. An absent or wrong mapping fails closed; the existence of some mapping is not authorization. Tests verify the stored mapping key and deadline, invalid/missing/error/cancellation behavior and conditional SSE field emission. Wrong-target rejection is tested in the Node platform adapter. Mapping freshness and an actual LID-based incoming phone call remain unverified.

The five-second deadline bounds the terminate query, not every upstream native cleanup operation. Pion relay close/configuration APIs are synchronous and do not accept that context; stalled native cleanup has not been validated. A caller timeout must remain unconfirmed, and deployment supervision must not interpret process exit or a canceled HTTP request as handset termination.

### Termination guard concurrency regression

Review found that the first termination patch read its new `Termination` field after releasing the call mutex in accept/transport handlers. A targeted concurrent-access test reproduced data races in both handlers. The corrected patch captures the stop decision while holding the mutex and rechecks it under that mutex before subsequent state/media mutations. The same test passes under `-race` after the fix. This does not claim that unrelated upstream pointer/state races have been audited or eliminated.

Relay configuration and local termination are serialized. Inspection of the pinned relay success/failure paths found no synchronous call back into `EndCall`; their connected callback updates call state and the server's state handler publishes events. A targeted synchronous connected-callback test completes without reentering the termination lock. Future callbacks must preserve this invariant; synchronous termination from those callbacks would deadlock. This serialization still does not add a context to Pion's synchronous close/configuration operations, so the native-cleanup limitation above remains.
