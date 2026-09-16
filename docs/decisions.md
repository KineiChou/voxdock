# Engineering decisions

Current decisions and evidence boundaries as of 2026-09-16. These describe the implementation, not production validation.

| Decision | Reason and consequence |
| --- | --- |
| One operator/backend and one active call | A single durable admission ledger keeps call identity, uncertain outcomes and resource limits explicit. No multitenant or distributed-worker claim. |
| TypeScript/Node 24, source execution with tsx | Control, runtime and adapter boundaries share types. `tsc --noEmit` checks source; it does not create a deployable JavaScript bundle. |
| SQLite on a local filesystem | State changes and event outbox share transactions. Run one bridge writer; preserve WAL consistency during backup. |
| Primary GPT-Live-1 WebSocket with client delegation | The application keeps business permissions and execution outside the voice model. Live audio is continuous; Realtime commit/voice-turn commands are not substituted. |
| teleproto plus NTgCalls | The deprecated GramJS package directs users toward teleproto. NTgCalls supplies native media; its published prerelease ABI requires explicit byte conversion verified by account-free checks. |
| Separate WaCalls process and small PCM patch | Reuse the pinned upstream protocol core. Authenticate call-bound media while keeping the upstream REST interface private. This is not an upstream-provided PCM WebSocket API. |
| Persistent FFmpeg resampling | Use an existing audio implementation for Telegram 48↔24 kHz conversion. Bound streams and cleanup; avoid custom interpolation or spawning a process per frame. |
| No automatic reconnect/redial to recover a call | A missing acknowledgment can hide a completed external side effect. Keep uncertain identity and reconcile instead of creating a duplicate call. |
| Source-alpha distribution and operator-local builds | Native account/media and Linux deployment evidence is incomplete. Original-code MIT licensing is distinct from native dependency redistribution. |

## Packaging provenance

The bridge Dockerfile pins Node `24.21.0-bookworm-slim`, pnpm `10.17.1` and Debian FFmpeg `7:5.1.9-0+deb12u1`. The [official Node image inventory](https://github.com/docker-library/official-images/blob/master/library/node) and [Debian FFmpeg package](https://packages.debian.org/bookworm/ffmpeg) were checked when selecting these versions. The optional sidecar builds WaCalls source revision `edeb31f0427aba896639db503153b777a405eccf` plus this repository's patch, using Go 1.26.4 and its locked JavaScript client dependencies. Base image digests and all OS dependency revisions are not yet a frozen release manifest. A package version pin can fail when a distribution repository retires that version; update it through a reviewed dependency change and rerun image validation.

The development host had no running Docker daemon, so image builds and account-free runtime checks ran in GitHub's Linux CI. Both images passed, including the actual service, native binding and streaming resampler inside the bridge image. This does not establish an operator deployment or real calling; see [acceptance](acceptance.md) for evidence and open gates, and [third-party notices](../THIRD_PARTY_NOTICES.md) for distribution boundaries.
