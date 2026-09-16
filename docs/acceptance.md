# Acceptance evidence

Evidence date: 2026-09-16. This repository is a source alpha, not an accepted production voice service. Each claim below is limited to the environment and check performed; a fixture or successful build does not establish a real phone conversation.

| Area | Evidence available | Still required |
| --- | --- | --- |
| Control/state | Automated tests for durable admission, idempotency, state transitions, recovery and retention | Deployed process failure/recovery exercises with real platform state |
| Backend | Contract, signed-event and receipt tests; independent SQLite example with durable simulated completion callbacks after restart/hangup | Operator backend integration and actual business execution |
| Live | Injected primary-WebSocket tests for startup, audio, delegation, commentary and finite finalization | Account access, a paid session, observed greeting, interruption and returned final usage |
| Audio | Actual paced synthetic 48↔24 kHz conversion on FFmpeg 6.0/macOS arm64, 6.1.1/Linux and 5.1.9/Debian container; exact sample counts, waveform order and bounded queue | Handset latency, drift, clipping and long-run audio quality |
| Telegram | Account-free NTgCalls load/create/external-input/cleanup on macOS arm64 and Linux x64 Node 24; signaling fixtures | Login and target verification, genuine outgoing/incoming calls, handset events and duplex voice |
| WhatsApp | Pinned Go server/core tests, race checks, loopback PCM and host/Linux amd64 builds; shared coordinator and identity/termination fixtures | Deployed media operation, account pairing, real calls and stored identity resolution |
| Packaging | Both Docker images built in Linux CI; bridge CLI init/doctor/start/authentication/process-lock/pause/shutdown/restart, NTgCalls and streaming FFmpeg run inside the image; private WaCalls starts with an empty account store; schema and Compose checks | Deployment, restore and upgrade with operator account volumes |
| Audit | JSON/HTML allowlisted summaries omit private text, identities, references and unknown fields; private full exports remain available | Operator review before sharing; timestamps and usage remain visible in summaries |
| Operational endurance | Bounded cleanup/queue behavior covered locally | 24-hour idle/active endurance, resource use and independent platform disconnection tests |
| Distribution | Source license and selected dependency notices | Complete binary/source/notice inventory, immutable image digests and a release audit |

Native evidence and exact upstream revisions are in [platforms](platforms.md); Go patch/build evidence is in [WaCalls media](wacalls-media.md). Live and PCM interpretation are documented in [Live/audio](live.md). CI status should be read for the tested commit; no historical green run proves a later change or a live platform capability.

The [Linux service run](https://github.com/KineiChou/voxdock/actions/runs/35108228782) passed 91 tests and the executable/native/FFmpeg checks. Synthetic first output was 59 ms for 48→24 kHz and 43 ms for 24→48 kHz in that run; these are resampler observations, not phone-call latency measurements.

The [container run](https://github.com/KineiChou/voxdock/actions/runs/35108934685) built and exercised both images without platform accounts. Inside the Debian bridge image, synthetic first output was 72 ms / 62 ms for the two conversion directions, with exact sample counts. These checks did not test pairing, handset audio or a paid Live session.

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
