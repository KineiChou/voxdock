# Acceptance evidence

Evidence updated: 2026-09-17. This repository is a source alpha, not an accepted production voice service. Each claim below is limited to the environment and check performed; a fixture or successful build does not establish a real phone conversation.

| Area | Evidence available | Still required |
| --- | --- | --- |
| Control/state | Automated tests for durable admission, idempotency, state transitions, recovery and retention | Deployed process failure/recovery exercises with real platform state |
| Backend | Contract, signed-event and receipt tests; SQLite simulation and optional OpenAI forwarding with durable callbacks, deduplication and interruption recovery; direct Sol connectivity | Live-to-backend phone delegation and actual business execution |
| Live | Injected primary-WebSocket tests plus a real 16 kHz start/close with returned final usage | Observed phone greeting, interruption, duplex voice and delegation |
| Audio | Actual paced synthetic 48↔24 kHz conversion on FFmpeg 6.0/macOS arm64, 6.1.1/Linux and 5.1.9/Debian container; exact sample counts, waveform order and bounded queue | Handset latency, drift, clipping and long-run audio quality |
| Telegram | Account-free NTgCalls load/create/external-input/cleanup on macOS arm64 and Linux x64/arm64 Node 24; signaling fixtures | Login and target verification, genuine outgoing/incoming calls, handset events and duplex voice |
| WhatsApp | Pinned Go server/core tests, race checks, loopback PCM and host/Linux amd64 builds; shared coordinator and identity/termination fixtures; deployed account paired/open | Deployed media operation, real calls and stored identity resolution |
| Packaging | Both Docker images built in Linux CI and on an ARM64 server; bridge CLI, native/FFmpeg checks, a paused systemd/Compose deployment and public HTTPS health/authentication pass; private WaCalls starts with an empty account store | Restore and upgrade with provisioned accounts |
| Audit | JSON/HTML allowlisted summaries omit private text, identities, references and unknown fields; private full exports remain available | Operator review before sharing; timestamps and usage remain visible in summaries |
| Operational endurance | Bounded cleanup/queue behavior covered locally | 24-hour idle/active endurance, resource use and independent platform disconnection tests |
| Distribution | Source license and selected dependency notices | Complete binary/source/notice inventory, immutable image digests and a release audit |

Native evidence and exact upstream revisions are in [platforms](platforms.md); Go patch/build evidence is in [WaCalls media](wacalls-media.md). Live and PCM interpretation are documented in [Live/audio](live.md). CI status should be read for the tested commit; no historical green run proves a later change or a live platform capability.

The [Linux service run](https://github.com/KineiChou/voxdock/actions/runs/35108228782) passed 91 tests and the executable/native/FFmpeg checks. Synthetic first output was 59 ms for 48→24 kHz and 43 ms for 24→48 kHz in that run; these are resampler observations, not phone-call latency measurements.

The [container run](https://github.com/KineiChou/voxdock/actions/runs/35108934685) built and exercised both images without platform accounts. Inside the Debian bridge image, synthetic first output was 72 ms / 62 ms for the two conversion directions, with exact sample counts. These checks did not test pairing, handset audio or a paid Live session.

## Paused ARM64 deployment

Source `6d9da44` was built and installed on a Rocky Linux 9.6 / aarch64 server using Docker 29.4.1 and Compose 5.1.3. Both images built from the checked-in Dockerfiles. The bridge image passed the executable CLI smoke, native NTgCalls smoke and actual streaming resampler smoke. The two conversion directions produced exactly 72,000 / 144,000 bytes; first output was 162 / 80 ms under the observed host load, not a handset latency measure.

The installed containers run as a dedicated non-root UID with read-only root filesystems and restricted persistent mounts. With SELinux enforcing, systemd startup and the bridge health check passed. Direct backend checks returned health 200, unauthenticated capabilities 401 and authenticated capabilities with calling/platforms disabled. The loopback-only WaCalls endpoint returned an empty account list.

After the operator opened the private network route, public HTTPS checks through the CDN and a separate Nginx edge returned health 200 and unauthenticated capabilities 401. A request from the deployed Node runtime authenticated through the same public URL and returned capabilities 200, with calling and both channels still disabled. TLS certificate validation passed. The Python checker's default request received a CDN 403/1010; an identified checker request and the application's Node fetch both passed without changing edge security settings. Private addresses, domains and credentials remain in the operator's deployment record, outside this repository.

## Controlled provider checks, 2026-09-17

Using operator-managed credentials on the ARM64 deployment, model reads for `gpt-live-1` and `gpt-5.6-sol` returned HTTP 200. A small Responses request to Sol completed with the expected reply (10 input / 5 output tokens). The deployed `LiveClient` started a real 16 kHz session, reached ready, received 19,200 output audio bytes and closed with complete finalization and one second of reported usage. The synthetic input and output were not saved or played to a phone. These results establish connectivity and the short session lifecycle, not a phone conversation, audio quality or actual delegation.

WaCalls subsequently reported one paired/open account and an empty active-call snapshot. Pairing had previously shown an iPhone connection error; the specific cause of the later successful pairing was not established, and no dependency upgrade was applied. Private identities and account material are excluded from this record.

## Real-call acceptance record

For each platform, record the source commit, dependency versions, host OS/architecture, client/device versions, account roles (redacted), configured limits, test start/end, expected behavior and observed evidence. At minimum, verify:

1. Correct fixed recipient; unrelated incoming callers cannot gain admission; one-call capacity applies to incoming and outgoing activity.
2. Answer/reject/busy/missed/cancel behavior and the difference between connected, audio-ready and actually heard speech.
3. Fresh business context before dialing and greeting; obsolete notifications are not read as current facts.
4. A continuous two-way conversation, interruption and later corrections associated with the same delegation and a newer context revision.
5. A durable backend receipt before claiming acceptance, with no duplicate side effect after retry or restart.
6. Ring/duration/daily limits, media loss, platform disconnect, server shutdown and a crash during uncertain side effects.
7. Final platform termination, Live usage or an explicit incomplete marker, consistent audit export and no silent automatic redial.
8. Retention cleanup, consistent backup/restore and absence of raw audio/credentials in persistent records and logs.

Attach redacted evidence to the relevant issue/PR. Do not substitute a model summary, a browser screenshot, an HTTP 200 or a commentary append acknowledgment for platform/receipt/usage evidence. Real platform and paid API checks are opt-in; normal tests must remain credential-free.
