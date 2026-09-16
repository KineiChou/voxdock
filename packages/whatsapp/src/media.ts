import WebSocket from 'ws';

export interface WaCallsMediaSession {
  writeAudio(pcm: Uint8Array): void;
  close(): void;
}
export type WaCallsMediaSocket = Pick<WebSocket, 'on' | 'off' | 'readyState' | 'bufferedAmount' | 'send' | 'terminate'>;
export interface WaCallsMediaOptions {
  baseUrl: string;
  sessionId: string;
  callId: string;
  mediaSecret: string;
  clientId?: string;
  signal?: AbortSignal;
  onAudio(pcm: Buffer): void;
  onClosed(reason: string): void;
  fetch?: typeof globalThis.fetch;
  WebSocketFactory?: (url: string, options: { headers: Record<string, string>; maxPayload: number; handshakeTimeout: number; perMessageDeflate: false }) => WaCallsMediaSocket;
}

const maxFrameBytes = 6400;
const maxBufferedBytes = 32000;
const timeoutMs = 10000;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('Media operation aborted'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, () => {
      signal.removeEventListener('abort', aborted); reject(new Error('Media operation failed'));
    });
  });
}

/** One call-bound connection. Credentials, tokens and audio are never logged or retained. */
export async function connectWaCallsMedia(options: WaCallsMediaOptions): Promise<WaCallsMediaSession> {
  let base: URL;
  try { base = new URL(options.baseUrl); } catch { throw new Error('Invalid WaCalls origin'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Invalid WaCalls origin');
  if (!options.sessionId || !options.callId || [options.sessionId, options.callId].some(id => id === '.' || id === '..') || options.sessionId.length > 512 || options.callId.length > 512) throw new Error('Invalid media identity');
  if (options.mediaSecret.length < 32 || /[\r\n]/.test(options.mediaSecret) || (options.clientId !== undefined && /[\r\n]/.test(options.clientId))) throw new Error('Invalid media credentials');

  const path = `/api/sessions/${encodeURIComponent(options.sessionId)}/calls/${encodeURIComponent(options.callId)}`;
  const abort = new AbortController();
  let socket: WaCallsMediaSocket | undefined;
  let ready = false;
  let closed = false;
  let rejectReady: ((error: Error) => void) | undefined;
  let detach = () => {};
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    abort.abort();
    detach();
    try { socket?.terminate(); } catch { /* transport already unavailable */ }
    rejectReady?.(new Error(`WaCalls media ${reason}`));
    try { options.onClosed(reason); } catch { /* cleanup must complete even if consumer fails */ }
  };
  const onAbort = () => finish('aborted');
  const timer = setTimeout(() => finish('startup_timeout'), timeoutMs);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) { finish('aborted'); throw new Error('WaCalls media aborted'); }

  let token: string;
  try {
    const response = await untilAbort((options.fetch ?? globalThis.fetch)(new URL(`${path}/media-token`, base), {
      method: 'POST', redirect: 'error', signal: abort.signal,
      headers: { Authorization: `Bearer ${options.mediaSecret}`, ...(options.clientId ? { 'X-Client-Id': options.clientId } : {}) },
    }), abort.signal);
    if (closed) throw new Error();
    if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error(); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await untilAbort(reader.read(), abort.signal);
        if (done) break;
        length += value.byteLength;
        if (length > 4096) throw new Error();
        chunks.push(value);
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!record(result) || typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(result.token) || typeof result.expires_at !== 'number' || !Number.isFinite(result.expires_at) || result.expires_at <= Date.now()) throw new Error();
    token = result.token;
  } catch {
    finish('token_failed');
    throw new Error('WaCalls media token request failed');
  }
  if (closed) throw new Error('WaCalls media closed during startup');

  const url = new URL(`${path}/media`, base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    socket = (options.WebSocketFactory ?? ((address, config) => new WebSocket(address, config)))(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }, maxPayload: maxFrameBytes,
      handshakeTimeout: timeoutMs, perMessageDeflate: false,
    });
  } catch {
    finish('connect_failed'); throw new Error('WaCalls media connection failed');
  }
  if (closed) { socket.on('error', () => {}); socket.terminate(); throw new Error('WaCalls media closed during startup'); }
  return new Promise<WaCallsMediaSession>((resolve, reject) => {
    rejectReady = reject;
    const session: WaCallsMediaSession = {
      writeAudio(pcm) {
        if (closed || !ready || socket!.readyState !== WebSocket.OPEN) throw new Error('WaCalls media is not ready');
        if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > maxFrameBytes) throw new Error('Invalid media PCM frame');
        if (socket!.bufferedAmount + pcm.byteLength > maxBufferedBytes) {
          finish('backpressure'); throw new Error('WaCalls media backpressure');
        }
        try { socket!.send(Buffer.from(pcm), { binary: true }, error => { if (error) finish('send_failed'); }); }
        catch { finish('send_failed'); throw new Error('WaCalls media send failed'); }
      },
      close() { finish('client_closed'); },
    };
    const message = (data: WebSocket.RawData, binary: boolean) => {
      if (closed) return;
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (bytes.length > maxFrameBytes) { finish('invalid_frame'); return; }
      if (!ready) {
        try {
          const event: unknown = JSON.parse(bytes.toString('utf8'));
          if (binary || !record(event) || event.type !== 'media.ready' || event.format !== 'pcm_s16le' || event.sample_rate !== 16000 || event.channels !== 1) throw new Error();
        } catch { finish('invalid_ready'); return; }
        ready = true;
        clearTimeout(timer);
        resolve(session);
        return;
      }
      if (!binary || !bytes.length || bytes.length % 2) { finish('invalid_frame'); return; }
      try { options.onAudio(Buffer.from(bytes)); } catch { finish('consumer_failed'); }
    };
    const close = () => finish('transport_closed');
    const error = () => finish('transport_failed');
    detach = () => {
      socket!.off('message', message); socket!.off('close', close); socket!.off('error', error);
      // ws can emit an error after terminate during an unfinished HTTP upgrade.
      socket!.on('error', () => {});
    };
    socket!.on('message', message); socket!.on('close', close); socket!.on('error', error);
    if (closed || options.signal?.aborted) finish('aborted');
  });
}
