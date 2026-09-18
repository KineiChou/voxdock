# Native platform adapters

Telegram uses an isolated teleproto/NTgCalls worker. WhatsApp uses the pinned WaCalls sidecar with controlled media and identity patches. Real account binding and incoming Telegram handshakes have been exercised; handset audio remains unvalidated. WhatsApp has sustained a two-minute Live/backend conversation, with unresolved handset termination and incoming-call retest requirements. See [known limitations](limitations.md).

## Locked upstreams

| Component | Version / source | Local evidence |
| --- | --- | --- |
| NTgCalls | npm `3.0.0-rc03`, source `4115768087d0b1cefdd84407293ca5c00a903f1e` | Official native package loads, constructs, and returns an empty calls map on Node 24.21.0 / macOS arm64 |
| teleproto | npm `1.229.0`, source `9b0ebd11151af3e362842b826e704e97ab398fa5` | Public phone request/accept/confirm/discard/signaling exports verified on Node 24 |
| WaCalls | `edeb31f0427aba896639db503153b777a405eccf` | Go 1.26.4 build succeeds for macOS arm64 and Linux amd64, CGO disabled for Linux |

NTgCalls native loading, byte ABI, external PCM input and cleanup also pass on Linux x64 Node 24, both on the CI host and inside the Debian bridge image. The WaCalls image starts with an empty account store in Linux CI. NTgCalls remains a prerelease dependency; these account-free checks do not establish real call negotiation or handset audio. See [known limitations](limitations.md).

### MTProto selection

The initially considered GramJS package `telegram@2.26.22` is explicitly deprecated on npm and directs users to teleproto. Its maintained fork describes independent development and exposes the needed phone schema. Use teleproto for new implementation, rather than building on the archived client. Schema/export checks do not establish server or account compatibility. The selected NTgCalls npm artifact differs from the earlier source snapshot; use the installed artifact's generated types as the integration contract.

Sources: [NTgCalls](https://github.com/pytgcalls/ntgcalls), [teleproto](https://github.com/sanyok12345/teleproto), [WaCalls fixed source](https://github.com/JotaDev66/WaCalls/tree/edeb31f0427aba896639db503153b777a405eccf).

## Implemented boundaries

Telegram identity validation accepts only stable positive int64 user IDs and requires distinct caller and target accounts. The signaling pipe binds one user ID to one platform call ID and access hash, bounds outbound signaling, copies native callback buffers, isolates late/wrong-call events and reports transport failure once. It uses actual NTgCalls callback/method names; account provisioning, fixed-target outbound DH negotiation, admitted inbound acceptance, discard and PCM media setup are now implemented against the pinned APIs. Mocked protocol fixtures verify sequencing; handset behavior remains unverified.

WhatsApp control uses the pinned upstream's actual HTTP routes, fixed session/client and target identity, no recording and no automatic dial retry. Its fixed HTTP(S) origin comes only from trusted operator configuration and rejects embedded credentials, URL paths, queries, fragments and redirects. Upstream has no authentication; this client does not add authentication. The upstream port must be restricted to trusted private processes or an authenticated proxy. Never accept the origin from a call request or model output.

The SSE decoder handles chunked UTF-8, CRLF, comments and multiline data with bounded events. Call events require matching session and provider call identity. Upstream `ringing` is written immediately by the start-call HTTP handler, so it maps to `dialing`; it is not evidence that the remote phone is ringing. SSE contains no durable cursor and its broker drops events for slow subscribers. A disconnected stream must trigger reconciliation or uncertain status, never automatic redial. Call-list/auth/QR events are ignored by the narrow call parser; raw events must not be logged.

The control client is a low-level transport. The [shared runtime](runtime.md) owns durable reservation, global single-call admission, state ordering, reconciliation, bounded timeouts, inbound approval and cleanup. Successful hangup HTTP response alone is not proof of a final platform event.

## Media boundary

The pinned upstream WaCalls browser bridge is a WebRTC DataChannel named `pcm`, using 16 kHz mono PCM16LE; internal callbacks use float32. VoxDock's [Go patch](wacalls-media.md) adds an authenticated, call/session-bound PCM WebSocket using `FeedCapturedPCM` and the existing output callback. This route is supplied by the local patch, not unmodified upstream. The patch also adds explicit termination evidence and stored identity mapping; it preserves the upstream call protocol.

## Reproduction

After `pnpm install --frozen-lockfile`, run `node packages/telegram/scripts/native-binding-smoke.cjs` on Node 24. Run adapter tests with Vitest. `node --import tsx packages/telegram/scripts/native-media-smoke.mts` additionally exercises creation, byte conversion, external 48 kHz mono PCM input and cleanup without any account or call. The smoke scripts live inside the Telegram package to resolve its declared dependencies under pnpm's isolated layout.

For WaCalls, checkout the fixed commit and run `go build ./cmd/server`. Linux build: `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/server`. Go 1.26.4 is required by upstream; a recent Go installation can fetch the toolchain automatically. Builds require downloading the pinned `go.mod`/`go.sum` dependencies.

Remaining account/device evidence: login/session persistence, target resolution, private call negotiation, handset ringing/answer/rejection, actual media timing and duplex audio, interruption, and cleanup/crash recovery with real platform state. Linux process and synthetic/native PCM checks already pass; they do not substitute for these real-world scenarios.

## Pinned native byte ABI defect

The rc03 generated TypeScript declarations label byte inputs as `Buffer`, but the native `JsReader<std::vector<T>>` specialization requires JavaScript arrays because `bytes::binary` aliases a vector. Passing Buffer to `initExchange` or `sendExternalFrame` fails with `An array was expected`; this was reproduced locally. `TelegramNativeBinding` converts byte inputs explicitly at that boundary, while retaining Buffer application interfaces. Outgoing `initExchange` requires null (no hash); an empty byte sequence instead selects the incoming-key path. The wrapper also handles exchange keys, signaling and relay peer tags. Source: [pinned addon template](https://github.com/pytgcalls/ntgcalls/blob/4115768087d0b1cefdd84407293ca5c00a903f1e/targets/node/addon.cc.tpl). Native smoke validates the correction; a dependency upgrade must repeat this ABI check.

## Account tooling and driver

`node scripts/platforms/telegram-account.mts --setup CONFIG.json` prompts for hidden phone/code/password input and creates a new 0600 session file without printing it. `--profile` connects an existing session and prints its stable user ID. Only explicit `--call` initiates a real call to the configured target, with a 45-second abort deadline. This is a platform diagnostic, not a Live conversation. Configuration contains `apiId`, `apiHashFile`, `sessionFile`, `accountId` and `targetId`; keep the API hash and session files outside source control. Setup refuses to overwrite an existing session file.

`TelegramDriver` accepts an authorized client, configured account/target IDs and state/audio/incoming callbacks. It exposes `dial(targetId, signal)`, `accept(ref, signal)`, `reject(ref)`, `end(ref)`, `writeAudio(ref, pcm)` and `close()`. Caller must reserve durable global capacity before dial/accept. Native audio is 48 kHz mono PCM16LE in 10 ms (960-byte) frames; the host supplies pacing and bounded queues. Platform `connected` and `onAudioReady` are separate. Incoming offers only produce callbacks; the manager decides admission. Unknown, foreign or video callers cannot be accepted. Platform uncertainty preserves the active reservation, and terminal discard evidence is required before admitting another call.

Fixture/identity/transport tests and strict TypeScript checks pass. The pinned WaCalls patch also passes server/core tests and race checks. Native account-free create/external input/stop and byte ABI smoke pass on macOS arm64 and Linux x64 Node 24.21.0. These checks cover local protocol and media boundaries; they do not establish end-to-end audio quality. See [known limitations](limitations.md).

Failure cleanup attempts one correlated platform discard when a provider reference exists; native cleanup failure does not suppress that attempt. The reservation clears only with terminal platform evidence and successful native cleanup. Updates remain subscribed during explicit close. Tests cover stale same-target updates arriving before the dial response and failed native connection cleanup.
