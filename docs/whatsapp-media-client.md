# WhatsApp PCM client

`connectWaCallsMedia` connects the server-side Node runtime to the patched WaCalls media endpoints documented in [WaCalls media](wacalls-media.md). It does not place a call or pair an account. Supply a configured trusted HTTP(S) origin, upstream session/call IDs, the shared media secret loaded by the application, and audio/closure callbacks.

```ts
const media = await connectWaCallsMedia({
  baseUrl: configuredWaCallsOrigin,
  sessionId,
  callId,
  mediaSecret,
  signal: callAbortController.signal,
  onAudio: pcm => playbackQueue.push(pcm),
  onClosed: reason => handleMediaClosure(reason),
});
media.writeAudio(pcmFrame);
// After the call ends:
media.close();
```

Connection first requests a fresh call-bound token using the shared-secret Authorization header, then sends that single-use token in the WebSocket Authorization header. Credentials and tokens never enter URLs or logs. HTTP redirects are refused; the WebSocket origin is derived from the same configured HTTP origin. URL credentials, query strings and non-root base paths are refused. The application must choose this origin from operator configuration, not an untrusted task payload.

The returned promise resolves only after the server declares `media.ready` with `pcm_s16le`, 16,000 samples/second and one channel. All subsequent audio is raw signed PCM16 little-endian. Send continuous paced input including silence; a normal 20 ms frame is 640 bytes. The client neither generates silence nor resamples, records or queues audio locally. The runtime owns capture timing and bounded playback queues. Input must be nonempty, even-sized and at most 6,400 bytes; output is validated against the same bounds. A transport buffer exceeding 32,000 bytes (one second of PCM) closes the connection rather than accepting more audio.

Startup has a ten-second total deadline covering token issuance and readiness. Abort cancels token fetching, an unfinished upgrade, or an established connection. `close()` is idempotent. `onClosed(reason)` receives one sanitized terminal reason for a started connection attempt; malformed configuration rejects before starting the attempt. No automatic retry, token reuse, reconnect or redial occurs. Late media is ignored after closure. If local close or failure disconnects the media socket, the Go adapter requests ending the upstream call; the control service must still reconcile actual call termination and any uncertain outcome.

For deterministic tests, options accept `fetch` and a ws-compatible `WebSocketFactory`. Six tests cover authorization/wire format, readiness, binary PCM, invalid frames, transport backpressure, expiry, cancellation during startup and after readiness, finite startup even with an uncooperative injected fetch, and terminal-event idempotency. On 2026-09-16 these tests and strict TypeScript checks passed on Node 24 with ws 8.21.3. No WhatsApp account, real phone, or paid model API was used. Combined Node-to-patched-Go and real-call validation remain required before claiming end-to-end operation.
