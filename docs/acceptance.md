# Acceptance evidence

Evidence updated: 2026-09-17. This repository is a source alpha, not an accepted production voice service. Each claim below is limited to the environment and check performed; a fixture or successful build does not establish a real phone conversation.

| Area | Evidence available | Still required |
| --- | --- | --- |
| Control/state | Automated tests for durable admission, idempotency, state transitions, recovery and retention | Deployed process failure/recovery exercises with real platform state |
| Backend | Contract tests, durable simulation/OpenAI callbacks, deduplication and recovery; one real Sol phone request completed, callback accepted and answer heard | Further failure/recovery checks; actual business execution remains outside the text backend |
| Live | Primary-WebSocket tests, real 16 kHz session/final usage, phone opening and a two-minute Live/Sol conversation | Interruption, longer conversations and clean phone termination |
| Audio | Actual paced synthetic 48↔24 kHz conversion on FFmpeg 6.0/macOS arm64, 6.1.1/Linux and 5.1.9/Debian container; exact sample counts, waveform order and bounded queue | Handset latency, drift, clipping and long-run audio quality |
| Telegram | Account-free NTgCalls load/create/external-input/cleanup on macOS arm64 and Linux x64/arm64 Node 24; signaling fixtures | Login and target verification, genuine outgoing/incoming calls, handset events and duplex voice |
| WhatsApp | Pinned Go tests/builds, loopback PCM, paired account and two-minute outbound media/Live/backend conversation | Handset failure display on duration-limit termination, corrected incoming admission and broader phone acceptance |
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

## First WhatsApp conversation, 2026-09-17

Candidate `08c55e2` was built on the ARM64 server and used for both the bridge and the OpenAI backend; the WaCalls image stayed at `6d9da44`. A single authorized outgoing call reached connected, media-ready and Live-ready. One partial-transcript delegation received accepted and completed results; its callback was accepted, and queued model input was cleared. The operator confirmed hearing the Chinese opening and backend answer. No raw audio was saved.

The call ended unexpectedly about 50 seconds after connection, before its 120-second limit. The bridge recorded `audio_failed`; WaCalls acknowledged the local termination request. The operator reported no intentional hangup. Live finalized with 44 seconds of reported usage. This is partial acceptance, not a clean-call pass. Investigation reproduced a pacing defect with an overflow after 50,000.05 ms under small recurring timer lateness. The nominal-deadline correction passes standalone and duplex regressions while retaining the original buffer bound; see [pacing evidence](live.md#pacing-drift-regression). The original call's exact failed buffer or operation was not identified by its generic error. New failures retain a specific sanitized boundary code. The instance was paused until the operator requested the retest below.

## Two-minute retest and incoming rejection, 2026-09-17

The operator requested one new outgoing call using bridge/backend image `d291d1e`, whose source tree matches merged `4e3b2a9`; WaCalls remained at `6d9da44`. The call connected at 01:24:10.249 UTC and entered ending at 01:26:10.253 with `duration_limit`, then ended at 01:26:10.521. It crossed the prior premature failure point without an audio error. One Sol delegation completed, both speakers produced transcript fragments, and Live settled 117 seconds. The operator reported normal conversation during the two minutes, then two tones and an iPhone “Call failed” display. A spoken advance warning was not confirmed. A signaling acknowledgment therefore still does not establish normal handset termination; the cause of that display is unresolved. No raw audio was saved and no automatic redial occurred.

A subsequent operator-initiated callback reached WaCalls while the bridge was enabled, ready and idle, but was immediately declined before entering the call ledger. The incoming peer used the device-qualified form `number:device@lid`; WaCalls supplied its stored phone mapping, but the Node admission regex recognized only `number@lid` and discarded that mapping. The fix recognizes the optional numeric device suffix and still requires a stored mapping to the fixed permitted phone. Its new regression failed on the original implementation and passes with the fix, including unmapped, foreign and malformed identity rejection. Successful handset acceptance after this change remains to be tested. The operator's separate self-call warning and device-notification observations are not explained by the parser defect alone.

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
