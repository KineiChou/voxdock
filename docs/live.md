# Live and audio boundary

VoxDock uses one primary GPT-Live-1 WebSocket per connected call. It sends `session.start`, waits for `session.started`, streams continuous mono signed PCM16 little-endian, and requests `session.close`. Authentication stays on the server. Defaults are Marin, client delegation and `store: false`; platform rates are 24 kHz for Telegram and 16 kHz for WhatsApp.

## Session and delegation

`@voxdock/live` exports `LiveClient`, `LiveEvent`, `LiveTransport` and `createOpenAITransport`. Startup accepts speaking instructions, a voice name or custom voice resource, the PCM rate, and one delegation mode. See [configuration](configuration.md) for the supported preferences and defaults.

Client delegation emits an opaque delegation ID and time offset. The runtime supplies a bounded transcript snapshot to the HTTP backend, correlates its durable result with that snapshot, and appends spoken commentary only to the matching active call. Appends with a non-null delegation ID must refer to a known client delegation. General context and greeting instructions use null.

Responses delegation configures OpenAI-managed reasoning and optional web search at startup. `response.event` envelopes carry a delegation ID and nested Responses lifecycle event. The client associates `response.created` with its response ID, gathers bounded text and source URLs from streamed items, and records terminal results. Terminal response snapshots alone do not contain the output. Live already returns managed output to speech; VoxDock does not dispatch the request to the external backend or append that answer again. Existing managed responses may finish during session closing for audit purposes.

Only web search is registered as a managed tool in this release. Custom function execution belongs to the client backend. Unknown function calls are not executed. Mode changes apply between calls; there is no live-call editor or automatic session recovery.

## Conversation and finalization

Use `thinking(content)` for quiet business context and `commentary(content, delegationId)` for speech-directed results. `instructions(content)` supports conversation behavior and the explicit greeting request. Each append has a conservative 500 UTF-8 byte cap below the provider's 500-token limit; this is not a tokenizer. The runtime splits bounded business context and result summaries into short appends. An append acknowledgment confirms context injection, not that the caller heard it or that business work succeeded.

Transcript events contain fragments and session-relative intervals, not completed turns. The server's [conversation projection](console-conversation.md) joins retained adjacent text without changing raw partial/final flags. The Live client retains bounded in-memory delegation state only. Audio is never persisted. Call audit retention is managed by the durable store.

Output audio has arbitrary chunk boundaries and no playback-complete event. Consume bytes in order at the configured rate. Sample count determines duration; transcript timestamps and commentary acknowledgments do not establish playback completion.

During closing, late transcript/usage and existing managed-response finalization events can arrive, while new audio output and delegations are suppressed. Closing times out after 15 seconds by default. Only a valid `session.closed` with final usage establishes complete finalization. Socket closure or timeout leaves usage incomplete even if an earlier cumulative usage update exists. Usage updates replace the cumulative total and are never summed.

## Audio transport

The transport limits incoming WebSocket payloads, disables compression, bounds startup and reports sanitized failure codes. Outgoing buffered bytes are capped; overflow terminates the session rather than silently dropping speech. It never automatically reconnects, replays commands or redials. Applications stop capture/playback when the session closes.

`@voxdock/audio` provides a bounded PCM queue and a monotonic pacer. At 24 kHz, 20 ms is 480 samples / 960 bytes; at 48 kHz it is 960 samples / 1,920 bytes. Odd network chunk boundaries are preserved. Underrun produces a padded/silent frame; overflow is explicit. Ordinary timer jitter follows nominal sample deadlines. A stall of a complete frame skips missed slots without a catch-up burst.

The queue accepts 16, 24 and 48 kHz but does not resample. `FfmpegResampler` uses a persistent FFmpeg process per direction for 48↔24 kHz conversion, bounded buffers and backpressure, input sample alignment, finite finalization and child cleanup. Raw input probing is limited to 32 bytes because the PCM format is already declared. Supply a trusted executable path and honor stream backpressure.

## Local verification

Unit tests exercise wire shapes, startup gating, delegation correlation, bounded output, audio decoding, finalization and pacing without accounts or paid services. To check the actual persistent resampler with synthetic audio:

```sh
FFMPEG_PATH=/trusted/ffmpeg node --import tsx packages/audio/scripts/streaming-smoke.ts
```

The smoke checks paced 440 Hz input in both conversion directions, output before input closure, final sample counts and the normal frame queue. It measures the local conversion path, not phone latency or perceptual quality. For platform and handset boundaries, see [known limitations](limitations.md).

Official references: [Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live), [delegation](https://developers.openai.com/api/docs/guides/live-delegation), [session management](https://developers.openai.com/api/docs/guides/live-conversations) and [FFmpeg format options](https://ffmpeg.org/ffmpeg-formats.html#Format-Options).
