import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { connectWaCallsMedia, type WaCallsMediaOptions, type WaCallsMediaSocket } from './media.js';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Buffer[] = [];
  terminate = vi.fn();
  send(bytes: Buffer, _options: unknown, callback: (error?: Error) => void) { this.sent.push(bytes); callback(); }
  message(value: object) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}
const ready = { type: 'media.ready', format: 'pcm_s16le', sample_rate: 16000, channels: 1 };
const token = 'a'.repeat(43);
function setup(overrides: Partial<WaCallsMediaOptions> = {}) {
  const socket = new Socket();
  const factory = vi.fn(() => socket as unknown as WaCallsMediaSocket);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ token, expires_at: Date.now() + 30000 })));
  const onAudio = vi.fn(); const onClosed = vi.fn();
  const options = { baseUrl: 'http://127.0.0.1:8080', sessionId: 's', callId: 'c', mediaSecret: 's'.repeat(32), fetch, WebSocketFactory: factory, onAudio, onClosed, ...overrides };
  const promise = connectWaCallsMedia(options);
  return { socket, factory, fetch, onAudio, onClosed, promise };
}
async function attached(s: ReturnType<typeof setup>) { await vi.waitFor(() => expect(s.factory).toHaveBeenCalledTimes(1)); }

describe('WaCalls call-bound media', () => {
  it('mints a token, uses header authorization, validates readiness and forwards PCM', async () => {
    const s = setup(); await attached(s);
    const [url, init] = s.fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/api/sessions/s/calls/c/media-token');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${'s'.repeat(32)}` } });
    expect(s.factory).toHaveBeenCalledWith('ws://127.0.0.1:8080/api/sessions/s/calls/c/media', expect.objectContaining({ headers: { Authorization: `Bearer ${token}` }, maxPayload: 6400 }));
    s.socket.message(ready); const session = await s.promise;
    session.writeAudio(Buffer.alloc(640)); expect(s.socket.sent).toEqual([Buffer.alloc(640)]);
    s.socket.emit('message', Buffer.alloc(640), true); expect(s.onAudio).toHaveBeenCalledWith(Buffer.alloc(640));
    session.close(); session.close(); s.socket.emit('close');
    expect(s.onClosed).toHaveBeenCalledExactlyOnceWith('client_closed');
    expect(s.socket.terminate).toHaveBeenCalledTimes(1);
  });
  it('rejects a wrong format and never retries or reuses its token', async () => {
    const s = setup(); const rejected = expect(s.promise).rejects.toThrow('invalid_ready');
    await attached(s); s.socket.message({ ...ready, sample_rate: 24000 }); await rejected;
    expect(s.fetch).toHaveBeenCalledTimes(1); expect(s.factory).toHaveBeenCalledTimes(1);
    expect(s.onClosed).toHaveBeenCalledExactlyOnceWith('invalid_ready');
  });
  it('bounds output buffering, validates local frames and suppresses late audio', async () => {
    const s = setup(); await attached(s); s.socket.message(ready); const session = await s.promise;
    expect(() => session.writeAudio(Buffer.alloc(3))).toThrow('Invalid media PCM');
    expect(() => session.writeAudio(Buffer.alloc(6402))).toThrow('Invalid media PCM');
    s.socket.bufferedAmount = 32000;
    expect(() => session.writeAudio(Buffer.alloc(640))).toThrow('backpressure');
    s.socket.emit('message', Buffer.alloc(640), true);
    expect(s.onAudio).not.toHaveBeenCalled(); expect(s.onClosed).toHaveBeenCalledExactlyOnceWith('backpressure');
    expect(() => session.writeAudio(Buffer.alloc(640))).toThrow('not ready');
  });
  it('aborts stalled token fetch and an unfinished handshake without exposing fetch errors', async () => {
    const a = new AbortController();
    const s = setup({ signal: a.signal, fetch: () => new Promise(() => {}) });
    const rejected = expect(s.promise).rejects.toThrow('token request failed'); a.abort(); await rejected;
    expect(s.factory).not.toHaveBeenCalled(); expect(s.onClosed).toHaveBeenCalledExactlyOnceWith('aborted');
    const b = new AbortController(); const t = setup({ signal: b.signal });
    const rejectedHandshake = expect(t.promise).rejects.toThrow('aborted'); await attached(t); b.abort(); await rejectedHandshake;
    expect(t.socket.terminate).toHaveBeenCalledTimes(1);
    const c = new AbortController(); const u = setup({ signal: c.signal });
    await attached(u); u.socket.message(ready); const session = await u.promise; c.abort();
    expect(u.onClosed).toHaveBeenCalledExactlyOnceWith('aborted');
    expect(() => session.writeAudio(Buffer.alloc(640))).toThrow('not ready');
  });
  it('rejects expired tokens and oversized incoming media with sanitized reasons', async () => {
    const s = setup({ fetch: async () => new Response(JSON.stringify({ token, expires_at: 1 })) });
    await expect(s.promise).rejects.toThrow('token request failed'); expect(s.factory).not.toHaveBeenCalled();
    const t = setup(); await attached(t); t.socket.message(ready); await t.promise;
    t.socket.emit('message', Buffer.alloc(6402), true);
    expect(t.onClosed).toHaveBeenCalledExactlyOnceWith('invalid_frame'); expect(t.onAudio).not.toHaveBeenCalled();
  });
  it('bounds startup even when an injected fetch ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ fetch: () => new Promise(() => {}) });
      const rejected = expect(s.promise).rejects.toThrow('token request failed');
      await vi.advanceTimersByTimeAsync(10000); await rejected;
      expect(s.onClosed).toHaveBeenCalledExactlyOnceWith('startup_timeout');
    } finally { vi.useRealTimers(); }
  });
});
