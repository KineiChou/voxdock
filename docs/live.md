# Live and audio boundary

The Live client implements one primary GPT-Live-1 WebSocket session with client delegation. It sends `session.start`, waits for `session.started`, streams raw mono signed PCM16 little-endian at 16 or 24 kHz, and requests `session.close`. The default is 24 kHz with Marin and `store: false`. Authentication stays in the server transport. No paid API call or account-access validation has been performed.

`@voxdock/live` exports `LiveClient`, `LiveEvent`, `LiveTransport`, and `createOpenAITransport`. Construct the transport with an API key, pass instructions and an event callback to the client, then call `start()`. Append audio only after `ready`; use `commentary(content, delegationId)` for backend results or `null` for general context. The caller must keep each append within the documented 500-token limit; the byte/character safety limits here are not a tokenizer. Commentary returns a local event ID. `commentaryAccepted` acknowledges context injection, not completed speech or successful business work.

Transcripts are fragments with session-relative intervals, not completed turns. Delegation events contain an opaque ID and target, not task text. The application combines them with conversation context and enforces permissions. This package retains no transcript or audio history and never persists it. It retains at most 1,024 delegation IDs during one session and clears them at shutdown. Repeated delegation IDs are ignored. No automatic reconnection, command replay, or dialing is implemented.

Primary output audio has arbitrary chunk boundaries and no playback completion event. Consume the bytes in order at the configured rate; sample count determines duration. Transcript timestamps and commentary acknowledgments must not be used as playback completion evidence. During closing, late transcripts and usage are accepted, but output audio and new delegations are suppressed. Closing times out after 15 seconds by default. Only valid `session.closed` with final usage yields complete finalization; socket closure and timeout yield incomplete usage even if earlier cumulative usage exists. Usage updates replace the cumulative total; they are never summed.

The transport limits incoming WebSocket payloads, disables compression, bounds startup, and sanitizes failures to fixed codes. Outgoing buffered bytes are capped, with overflow terminating the session instead of silently dropping speech. API error messages and payloads are not logged. Applications must stop their capture/playback loop on `closed` and handle any business results that arrive afterward outside this session.

`@voxdock/audio` provides a bounded PCM frame queue and a caller-driven monotonic pacer. At 24 kHz, 20 ms is 480 samples / 960 bytes; at 48 kHz it is 960 samples / 1,920 bytes. Odd network chunk boundaries are preserved across pushes. Underrun emits a padded/silent frame; overflow is explicit. Delayed ticks never emit a catch-up burst. The queue accepts 16, 24 and 48 kHz but does not resample. Platform adapters must supply the declared format; `FfmpegResampler` provides a persistent FFmpeg process per direction for 48↔24 kHz conversion, with bounded stream buffers, input sample alignment, pipe backpressure, finite finalization, and child cleanup. Supply a trusted executable path; consumers must honor stream backpressure. No FFmpeg binary was available for a real DSP test, so resampling quality, sample-count output, startup buffering and latency remain unverified. No native platform sample layout or end-to-end audio quality has been validated here.

## Evidence and decisions

On 2026-09-16 the implementation was checked against official [primary WebSocket documentation](https://developers.openai.com/api/docs/guides/voice-websockets?api=live), [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), and [session management](https://developers.openai.com/api/docs/guides/live-conversations). The wire client uses `ws` directly so transport behavior can be tested without invoking a service. It does not depend on Realtime input commit or voice `response.create` semantics.

Deterministic tests cover startup gating, wire shapes, delegation and commentary correlation, fragment timing, output decoding, bounded buffering, close timeout, incomplete finalization, late-event suppression, sample math, silence, pacing, and injected resampler process cleanup/limits. These are protocol/unit tests with injected transport, not proof of model availability, real-network compatibility, native media quality, latency, or actual phone calls. Real audio and account smoke tests remain required before claiming those capabilities.

The transport pins ws 8.21.3 after checking upstream [release notes](https://github.com/websockets/ws/releases/tag/8.21.3) and the [fragment exhaustion advisory](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p), fixed in 8.21.0. Earlier 8.18.x candidates were discarded before integration. This is an upstream advisory check, not a complete security audit.

## Review corrections

A command rejection does not establish session termination. The client now reports
a sanitized fault and continues awaiting the actual final event; startup rejection
still ends an unusable session. A regression test preserves final usage after a
rejected append.

Both commentary and instruction appends enforce a conservative 500 UTF-8 byte
cap, instead of accepting 8,000 characters against the provider's 500-token limit.
Long business results should be summarized into short factual statements by the
backend. `instructions()` supports the explicit greeting request; its acknowledgment
is not proof that the caller heard it.
