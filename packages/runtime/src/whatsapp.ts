import { WaCallsControl, normalizePhone, decodeSse, parseCallEvent, connectWaCallsMedia, type WaCallsMediaSession, type WaCallsMediaOptions } from '@voxdock/whatsapp';
import type { VoiceDriver, VoiceEvents } from './types.js';
import { deadline } from './deadline.js';

export interface WhatsAppOptions {
  baseUrl: string; sessionId: string; peerId: string; mediaSecret: string;
  fetch?: typeof fetch;
  media?: (options: WaCallsMediaOptions) => Promise<WaCallsMediaSession>;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** WhatsApp phone-number JIDs are stable here; unresolved LIDs cannot authorize a caller. */
export function whatsAppPhone(identity: string): string {
  const jid = /^([1-9][0-9]{6,14})(?::[0-9]+)?@s\.whatsapp\.net$/.exec(identity);
  return jid ? jid[1]! : normalizePhone(identity);
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('WaCalls response unavailable');
  const reader = response.body.getReader();
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 5000);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) throw new Error('WaCalls response exceeds limit'); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function createWhatsAppDriver(options: WhatsAppOptions, callbacks: VoiceEvents): Promise<VoiceDriver> {
  const base = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Invalid WaCalls origin');
  if (!options.sessionId || ['.', '..'].includes(options.sessionId) || options.sessionId.length > 200) throw new Error('Invalid session binding');
  if (options.mediaSecret.length < 32 || /[\r\n]/.test(options.mediaSecret)) throw new Error('Invalid media secret');
  const targetPhone = whatsAppPhone(options.peerId);
  const transport = options.fetch ?? fetch;
  const clientId = `voxdock:${options.sessionId}`;
  const streamAbort = new AbortController();
  const request = async (path: string, method: string): Promise<Response> => {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 5000);
    try {
      return await deadline(transport(new URL(path, base), { method, signal: abort.signal, redirect: 'error', headers: { 'X-Client-Id': clientId } }), 5000);
    } finally { clearTimeout(timer); }
  };
  const sessionResponse = await deadline(boundedJson(await request('/api/sessions', 'GET')), 5000);
  if (!record(sessionResponse) || !Array.isArray(sessionResponse.sessions)) throw new Error('Invalid WaCalls session listing');
  const sessions = sessionResponse.sessions.filter((session: unknown) => record(session) && session.id === options.sessionId);
  const session: unknown = sessions[0];
  if (sessions.length !== 1 || !record(session) || session.paired !== true || session.state !== 'open' || typeof session.jid !== 'string') throw new Error('Configured WaCalls session must already be paired and open');
  const ownPhone = whatsAppPhone(session.jid);
  const control = new WaCallsControl({ baseUrl: options.baseUrl, sessionId: options.sessionId, clientId, ownPhone, targetPhone, fetch: transport });
  const mediaFactory = options.media ?? connectWaCallsMedia;
  let closed = false; let failed = false; let reserving = false;
  let active: { ref: string; media?: WaCallsMediaSession; connecting: boolean; mediaFailed: boolean; localEnding: boolean; terminal: boolean; abort: AbortController } | undefined;
  const offered = new Map<string, boolean>();
  const early: string[] = [];
  let lastChunk = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let snapshotResolve!: () => void; let snapshotReject!: (error: Error) => void;
  let snapshotSeen = false;
  const snapshot = new Promise<void>((resolve, reject) => { snapshotResolve = resolve; snapshotReject = reject; });
  const fault = () => {
    if (closed || failed) return;
    failed = true; clearInterval(heartbeat); streamAbort.abort(); active?.abort.abort(); active?.media?.close();
    snapshotReject(new Error('WaCalls event stream unavailable'));
    callbacks.fault();
    if (active) callbacks.state(active.ref, 'uncertain');
  };
  const failMedia = (call: NonNullable<typeof active>) => {
    if (closed || failed || active !== call || call.localEnding || call.terminal || call.mediaFailed) return;
    call.mediaFailed = true;
    call.abort.abort(); call.media?.close();
    // Media and signaling can close in either order; retain the terminal evidence stream.
    callbacks.state(call.ref, 'uncertain');
  };
  const startMedia = async () => {
    const call = active;
    if (!call || call.connecting || call.mediaFailed || call.localEnding || call.terminal || failed) return;
    call.connecting = true;
    try {
      const media = await mediaFactory({ baseUrl: options.baseUrl, sessionId: options.sessionId, callId: call.ref, mediaSecret: options.mediaSecret,
        clientId, signal: call.abort.signal, fetch: transport,
        onAudio: pcm => { if (active === call && !call.mediaFailed && !call.localEnding && !call.terminal) callbacks.audio(call.ref, pcm); },
        onClosed: () => failMedia(call),
      });
      if (active !== call || call.mediaFailed || call.localEnding || call.terminal || failed || closed) { media.close(); return; }
      call.media = media; callbacks.audioReady(call.ref);
    } catch { failMedia(call); }
  };
  const event = (text: string) => {
    const value: unknown = JSON.parse(text);
    if (!record(value) || typeof value.type !== 'string') throw new Error('Invalid WaCalls event');
    if (value.type === 'session-list') {
      if (!Array.isArray(value.sessions)) throw new Error('Invalid sessions snapshot');
      const selected: unknown = value.sessions.find((item: unknown) => record(item) && item.id === options.sessionId);
      if (!record(selected) || selected.paired !== true || selected.state !== 'open' || typeof selected.jid !== 'string' || whatsAppPhone(selected.jid) !== ownPhone) throw new Error('WaCalls account changed');
      return;
    }
    if (value.type === 'call-list') {
      if (!Array.isArray(value.calls)) throw new Error('Invalid calls snapshot');
      const calls = value.calls.filter((item: unknown) => record(item) && item.sessionId === options.sessionId);
      if (!snapshotSeen) {
        if (calls.length) throw new Error('Existing upstream calls require reconciliation');
        snapshotSeen = true; snapshotResolve();
      }
      return;
    }
    if (value.sessionId !== options.sessionId) return;
    if (value.type === 'auth-state') { if (value.state !== 'open' || value.paired !== true) throw new Error('WaCalls account unavailable'); return; }
    if (value.type === 'incoming') {
      if (typeof value.id !== 'string' || value.id.length > 200 || typeof value.peer !== 'string') throw new Error('Invalid incoming identity');
      if (offered.has(value.id) || active?.ref === value.id) return;
      if (offered.size >= 16) throw new Error('Too many incoming offers');
      let allowed = false;
      try {
        const identity = /^[1-9][0-9]*(?::[0-9]+)?@lid$/.test(value.peer) && typeof value.peer_phone_jid === 'string' ? value.peer_phone_jid : value.peer;
        allowed = whatsAppPhone(identity) === targetPhone;
      } catch { /* unresolved peers are not approved */ }
      offered.set(value.id, allowed); callbacks.incoming(value.id, allowed); return;
    }
    if (reserving && !active) { if (early.length >= 32) throw new Error('Too many early call events'); early.push(text); return; }
    if (!active) return;
    const parsed = parseCallEvent(text, options.sessionId, active.ref);
    if (!parsed) return;
    if (parsed.state === 'ended') {
      const call = active; call.terminal = true; call.abort.abort(); call.media?.close();
      // Upstream local EndCall ignores its asynchronous signaling result.
      const explicitEvidence = value.termination === 'acknowledged' || value.termination === 'remote';
      const uncertain = !explicitEvidence && (value.termination === 'unconfirmed' || call.mediaFailed || call.localEnding || failed || ['failed', 'timeout', 'unknown'].includes(parsed.reason ?? 'unknown'));
      callbacks.state(call.ref, uncertain ? 'uncertain' : 'ended');
      if (!uncertain) active = undefined;
      return;
    }
    if (active.localEnding || active.terminal) return;
    callbacks.state(active.ref, parsed.state);
    if (parsed.state === 'connected') void startMedia();
  };
  let stream: ReadableStream<Uint8Array>;
  try { stream = await deadline(control.events(streamAbort.signal), 5000); } catch { streamAbort.abort(); throw new Error('WaCalls events unavailable'); }
  const measured = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { lastChunk = Date.now(); controller.enqueue(chunk); } }));
  heartbeat = setInterval(() => { if (Date.now() - lastChunk > 45000) fault(); }, 10000);
  const reading = (async () => { try { for await (const text of decodeSse(measured)) { if (closed) break; event(text); } if (!closed) fault(); } catch { if (!closed) fault(); } })();
  try { await deadline(snapshot, 5000); if (failed || closed) throw new Error('WaCalls unavailable'); } catch { closed = true; streamAbort.abort(); clearInterval(heartbeat); throw new Error('WaCalls readiness snapshot failed'); }
  async function action(ref: string, operation: 'accept' | 'reject'): Promise<void> {
    const response = await request(`/api/sessions/${encodeURIComponent(options.sessionId)}/calls/${encodeURIComponent(ref)}/${operation}`, 'POST');
    if (!response.ok) { await response.body?.cancel(); throw new Error('WaCalls action outcome unknown'); }
    await response.body?.cancel();
  }
  return {
    rate: 16000, frameMs: 20,
    async dial(peerId, signal) {
      if (whatsAppPhone(peerId) !== targetPhone || active || reserving || failed || closed) throw new Error('WhatsApp target or call slot unavailable');
      reserving = true;
      try {
        const ref = await deadline(control.dial(signal), 10000);
        active = { ref, connecting: false, mediaFailed: false, localEnding: false, terminal: false, abort: new AbortController() };
        reserving = false;
        callbacks.state(ref, 'dialing'); for (const text of early.splice(0)) event(text);
        return ref;
      } catch { fault(); throw new Error('WhatsApp dial outcome unknown'); }
      finally { reserving = false; }
    },
    async accept(ref, signal) {
      signal.throwIfAborted();
      if (offered.get(ref) !== true || active || reserving || failed || closed) throw new Error('WhatsApp incoming call is not admitted');
      active = { ref, connecting: false, mediaFailed: false, localEnding: false, terminal: false, abort: new AbortController() }; offered.delete(ref);
      try { await action(ref, 'accept'); return ref; } catch { fault(); throw new Error('WhatsApp acceptance outcome unknown'); }
    },
    async reject(ref) { if (!offered.has(ref)) throw new Error('Unknown incoming offer'); await action(ref, 'reject'); offered.delete(ref); },
    async end(ref) {
      const call = active;
      if (!call || call.ref !== ref) throw new Error('Unknown WhatsApp call');
      if (call.localEnding) return;
      call.localEnding = true; call.abort.abort(); call.media?.close(); callbacks.state(ref, 'ending');
      try {
        const response = await request(`/api/sessions/${encodeURIComponent(options.sessionId)}/calls/${encodeURIComponent(ref)}`, 'DELETE');
        // Patched upstream reports receipt of the terminate stanza, not proof of handset playback.
        const result = await deadline(boundedJson(response), 5000);
        if (!record(result) || result.status !== 'ended' || !['acknowledged', 'remote'].includes(String(result.termination))) throw new Error('Unconfirmed hangup');
        call.terminal = true; callbacks.state(ref, 'ended'); if (active === call) active = undefined;
      } catch {
        if (!call.terminal || active === call) callbacks.state(ref, 'uncertain');
      }
    },
    async writeAudio(ref, pcm) { if (!active || active.ref !== ref || active.mediaFailed || active.localEnding || active.terminal || !active.media || pcm.length !== 640) throw new Error('WhatsApp media unavailable'); active.media.writeAudio(pcm); },
    async close() {
      if (closed) return;
      closed = true; clearInterval(heartbeat); streamAbort.abort();
      if (active) { active.localEnding = true; active.abort.abort(); active.media?.close(); await deadline(control.end(active.ref, AbortSignal.timeout(5000)), 5000).catch(() => {}); }
      await deadline(reading, 1000).catch(() => {});
    },
  };
}
