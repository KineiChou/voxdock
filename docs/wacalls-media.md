# WaCalls server-side PCM adapter

This patch adds an authenticated binary WebSocket media adapter to [JotaDev66/WaCalls](https://github.com/JotaDev66/WaCalls) at commit `edeb31f0427aba896639db503153b777a405eccf`. It replaces the need for a browser media leg when used by VoxDock. It preserves WhatsApp packet construction, encryption, MLow and RTP algorithms. The patch supplies correlated termination acknowledgments as described below. The upstream browser bridge already converts mono 16 kHz PCM16 little-endian to/from the call manager's float32 callbacks; this adapter reuses the same converters. It does not relabel or resample audio.

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

## Licensing

The patch preserves upstream MIT attribution in `patches/wacalls/UPSTREAM-LICENSE` and includes that license alongside built binaries. Review upstream dependencies and applicable licenses before distributing a complete image.

## Termination evidence

The patch stops local media and waits for a bounded, correlated `ack` with `class=call`, matching stanza ID and no error indication. A nil response, query error, cancellation or mismatched acknowledgment produces an unconfirmed result. The call remains reserved and later accept/transport/ack updates cannot restart its media. Repeated end requests do not resend a query after acknowledged or unconfirmed termination. A correlated remote termination event can resolve the retained call.

Successful `DELETE /api/sessions/{sid}/calls/{id}` returns HTTP 200 with `{ "status": "ended", "termination": "acknowledged" }`, or `"remote"` if a peer event resolved it. `acknowledged` means the signaling request was acknowledged and local media was closed; **it does not prove the handset observed closure**. An unconfirmed outcome returns HTTP 502 `{ "error": "hangup_unconfirmed" }`; a missing active call returns 404 rather than inventing confirmation. The additive `termination` field on `call-ended` SSE/history distinguishes `acknowledged`, `remote`, and `unconfirmed`. Local rejection follows the upstream asynchronous path and is explicitly unconfirmed; it is not relabeled as a remote hangup.

## Stored LID identity mapping

An incoming WhatsApp LID is not a phone number. The patch optionally adds `peer_phone_jid` to an `incoming` SSE event only when the authenticated account's existing `client.Store.LIDs.GetPNForLID` mapping resolves it to a valid phone JID. The original `peer` remains unchanged. This uses the pinned whatsmeow store API, not a network lookup or a conversion of LID digits. A one-second context bounds the local lookup; missing, invalid, errored or canceled results omit the field. Closed calls are not reannounced after lookup.

The Node admission layer must compare the mapped phone JID to its configured target. An absent or wrong mapping fails closed; the existence of some mapping is not authorization. See [known limitations](limitations.md) for incoming-call and identity interoperability boundaries.

The five-second deadline bounds the terminate query, not every upstream native cleanup operation. Pion relay close/configuration APIs are synchronous and do not accept that context; stalled native cleanup has not been validated. A caller timeout must remain unconfirmed, and deployment supervision must not interpret process exit or a canceled HTTP request as handset termination.

### Concurrency and native cleanup

The call mutex protects termination state and stop decisions before subsequent
state/media mutations. The registry reads the current media sink under its lock
before audio delivery. Relay configuration and local termination are serialized.
Relay callbacks must not synchronously reenter `EndCall` while that serialization
lock is held. This invariant prevents termination/transport overlap without
changing the upstream synchronous cleanup APIs.

See [known limitations](limitations.md) for native cleanup and handset termination
boundaries.
