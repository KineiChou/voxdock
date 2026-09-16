# Native platform adapters

Evidence date: 2026-09-16. No accounts were authenticated and no calls were made.

## Locked upstreams

| Component | Version / source | Local evidence |
| --- | --- | --- |
| NTgCalls | npm `3.0.0-rc03`, source `4115768087d0b1cefdd84407293ca5c00a903f1e` | Official native package loads, constructs, and returns an empty calls map on Node 24.21.0 / macOS arm64 |
| teleproto | npm `1.229.0`, source `9b0ebd11151af3e362842b826e704e97ab398fa5` | Public phone request/accept/confirm/discard/signaling exports verified on Node 24 |
| WaCalls | `edeb31f0427aba896639db503153b777a405eccf` | Go 1.26.4 build succeeds for macOS arm64 and Linux amd64, CGO disabled for Linux |

NTgCalls has a published Linux x64 optional native package. Linux native loading still requires CI verification; a cross-compiled Go executable is not a Linux runtime test. NTgCalls is a prerelease dependency and no native call or PCM operation has been validated end to end.

### MTProto selection

The initially considered GramJS package `telegram@2.26.22` is explicitly deprecated on npm and directs users to teleproto. Its maintained fork describes independent development and exposes the needed phone schema. Use teleproto for new implementation, rather than building on the archived client. Schema/export checks do not establish server or account compatibility. The selected NTgCalls npm artifact differs from the earlier source snapshot; use the installed artifact's generated types as the integration contract.

Sources: [NTgCalls](https://github.com/pytgcalls/ntgcalls), [teleproto](https://github.com/sanyok12345/teleproto), [WaCalls fixed source](https://github.com/JotaDev66/WaCalls/tree/edeb31f0427aba896639db503153b777a405eccf).

## Implemented boundaries

Telegram identity validation accepts only stable positive int64 user IDs and requires distinct caller and target accounts. The signaling pipe binds one user ID to one platform call ID and access hash, bounds outbound signaling, copies native callback buffers, isolates late/wrong-call events and reports transport failure once. It uses actual NTgCalls callback/method names; it does not implement account authorization, key exchange, dialing or media startup.

WhatsApp control uses the pinned upstream's actual HTTP routes, fixed session/client and target identity, no recording and no automatic dial retry. It requires a numeric loopback HTTP origin and rejects redirects. Upstream has no authentication: loopback is an internal transport restriction, not an authentication implementation. Only trusted local processes may access the upstream port. Remote deployment needs an authenticated private proxy or an authenticated upstream patch before relaxing this restriction.

The SSE decoder handles chunked UTF-8, CRLF, comments and multiline data with bounded events. Call events require matching session and provider call identity. Upstream `ringing` is written immediately by the start-call HTTP handler, so it maps to `dialing`; it is not evidence that the remote phone is ringing. SSE contains no durable cursor and its broker drops events for slow subscribers. A disconnected stream must trigger reconciliation or uncertain status, never automatic redial. Call-list/auth/QR events are ignored by the narrow call parser; raw events must not be logged.

The control client is not a complete call adapter: callers still own durable reservation, global single-call admission, state ordering, reconciliation, bounded timeouts, inbound approval and cleanup. Successful hangup HTTP response alone is not proof of a final platform event.

## Media boundary

The pinned WaCalls browser bridge is a WebRTC DataChannel named `pcm`, using 16 kHz mono PCM16LE; internal callbacks use float32. There is no upstream PCM WebSocket route. A future internal Go media adapter must bind authenticated media to an existing call/session and reuse `FeedCapturedPCM` plus the existing output callback. No protocol implementation has been copied into this repository.

## Reproduction

Install exact `ntgcalls@3.0.0-rc03` and `teleproto@1.229.0`, then run `node scripts/platforms/native-smoke.cjs` on Node 24. Run adapter tests with `node --test packages/telegram/src/*.test.ts packages/whatsapp/src/*.test.ts`.

For WaCalls, checkout the fixed commit and run `go build ./cmd/server`. Linux build: `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/server`. Go 1.26.4 is required by upstream; a recent Go installation can fetch the toolchain automatically. Builds require downloading the pinned `go.mod`/`go.sum` dependencies.

Remaining runtime evidence: login/session persistence, target resolution, private call negotiation, handset ringing/answer/rejection, external PCM formats and timing, duplex audio, interruption, timeout cleanup, crash recovery and Linux process operation. These require a separately authorized account/device test, not mock assertions.
