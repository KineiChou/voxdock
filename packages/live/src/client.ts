import { randomUUID } from 'node:crypto';
import { serializeDelegation, type LiveDelegationConfig } from './delegation-config.js';
import { ManagedResponses, type ManagedResponse } from './managed-responses.js';
export type { LiveDelegationConfig, ResponsesDelegationConfig } from './delegation-config.js';

export interface LiveTransport {
  readonly bufferedAmount: number;
  send(message: string): void;
  terminate(): void;
  subscribe(handlers: { open(): void; message(text: string): void; close(): void; error(): void }): () => void;
}
export interface LiveConfig {
  instructions: string;
  voice?: string | { id: string };
  delegation?: LiveDelegationConfig;
  rate?: 16000 | 24000;
  startTimeoutMs?: number;
  closeTimeoutMs?: number;
  maxBufferedBytes?: number;
}
export type LiveEvent =
  | { type: 'ready'; sessionId: string }
  | { type: 'audio'; pcm: Buffer }
  | { type: 'transcript'; speaker: 'user' | 'assistant'; delta: string; startMs: number; endMs: number; eventId?: string }
  | { type: 'delegation'; id: string; target: 'client' | 'responses'; offsetMs: number }
  | ManagedResponse
  | { type: 'commentaryAccepted' | 'instructionsAccepted' | 'thinkingAccepted'; clientEventId: string }
  | { type: 'usage'; seconds: number }
  | { type: 'fault'; code: string; clientEventId?: string }
  | { type: 'closed'; finalization: 'complete' | 'incomplete'; reason: string; seconds?: number };

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** One primary session; never reconnects/replays commands or retains audio/transcripts. */
export class LiveClient {
  private state: 'new' | 'starting' | 'ready' | 'closing' | 'closed' = 'new';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private seconds: number | undefined;
  private readonly delegations = new Map<string, 'client' | 'responses'>();
  private readonly managed = new ManagedResponses();
  private readonly config: Required<LiveConfig>;
  constructor(private readonly transport: LiveTransport, config: LiveConfig, private readonly emit: (event: LiveEvent) => void) {
    this.config = { delegation: { type: 'client' }, voice: 'marin', rate: 24000, startTimeoutMs: 15000, closeTimeoutMs: 15000, maxBufferedBytes: 128000, ...config };
    this.config.delegation = serializeDelegation(this.config.delegation);
    if (typeof this.config.voice !== 'string') this.config.voice = { id: this.config.voice.id };
    if (![16000, 24000].includes(this.config.rate)) throw new Error('Unsupported Live PCM rate');
    for (const n of [this.config.startTimeoutMs, this.config.closeTimeoutMs, this.config.maxBufferedBytes]) {
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid Live limit');
    }
  }
  start(): void {
    if (this.state !== 'new') throw new Error('Live session already started');
    this.state = 'starting';
    this.timer = setTimeout(() => this.finish(false, 'start_timeout'), this.config.startTimeoutMs);
    try {
      const unsubscribe = this.transport.subscribe({
      open: () => { if (this.state === 'starting') { try { this.send({ type: 'session.start', session: {
        model: 'gpt-live-1', instructions: this.config.instructions, store: false,
        audio: { format: { type: 'audio/pcm', rate: this.config.rate }, output: { voice: this.config.voice } },
        delegation: this.config.delegation,
      } }); } catch { /* send already finalized the session */ } } },
      message: text => this.receive(text),
      close: () => this.finish(false, 'transport_closed'),
      error: () => this.finish(false, 'transport_error'),
      });
      this.unsubscribe = unsubscribe;
      // Injected transports may deliver a terminal event synchronously on subscription.
      if ((this.state as string) === 'closed') unsubscribe();
    } catch { this.finish(false, 'connect_failed'); }
  }
  appendAudio(pcm: Uint8Array): void {
    this.requireReady();
    if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > this.config.rate * 2) throw new Error('Invalid PCM16 chunk');
    this.send({ type: 'session.input_audio.append', audio: Buffer.from(pcm).toString('base64') });
  }
  commentary(content: string, delegationId: string | null = null): string {
    return this.append('commentary', content, delegationId);
  }
  instructions(content: string, delegationId: string | null = null): string {
    return this.append('instructions', content, delegationId);
  }
  thinking(content: string, delegationId: string | null = null): string {
    return this.append('thinking', content, delegationId);
  }
  private append(kind: 'commentary' | 'instructions' | 'thinking', content: string, delegationId: string | null): string {
    this.requireReady();
    // Conservative byte cap keeps brief multilingual appends below the API token limit.
    if (!content.trim() || Buffer.byteLength(content, 'utf8') > 500) throw new Error('Append exceeds 500 UTF-8 bytes');
    if (delegationId !== null && this.delegations.get(delegationId) !== 'client') throw new Error('Unknown delegation');
    const id = randomUUID();
    this.send({ type: `session.${kind}.append`, event_id: id, delegation_id: delegationId, content });
    return id;
  }
  close(): void {
    if (this.state === 'closed' || this.state === 'closing') return;
    if (this.state !== 'ready') { this.finish(false, 'closed_before_ready'); return; }
    this.state = 'closing';
    this.timer = setTimeout(() => this.finish(false, 'close_timeout'), this.config.closeTimeoutMs);
    try { this.send({ type: 'session.close' }); } catch { /* already finalized */ }
  }
  private requireReady(): void { if (this.state !== 'ready') throw new Error('Live session is not ready'); }
  private send(event: object): void {
    const text = JSON.stringify(event);
    if (this.transport.bufferedAmount + Buffer.byteLength(text) > this.config.maxBufferedBytes) {
      this.finish(false, 'backpressure');
      throw new Error('Live transport backpressure');
    }
    try { this.transport.send(text); }
    catch { this.finish(false, 'send_failed'); throw new Error('Live send failed'); }
  }
  private receive(text: string): void {
    if (this.state === 'closed') return;
    if (Buffer.byteLength(text) > 2_000_000) { this.finish(false, 'oversized_event'); return; }
    let e: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(text); if (!object(parsed) || typeof parsed.type !== 'string') throw new Error(); e = parsed; }
    catch { this.finish(false, 'malformed_event'); return; }
    if (e.type === 'error') {
      const detail = object(e.error) ? e.error : {};
      const code = typeof detail.code === 'string' && /^[a-z0-9_]{1,80}$/.test(detail.code) ? detail.code : 'server_error';
      this.emit({ type: 'fault', code, ...(typeof detail.client_event_id === 'string' ? { clientEventId: detail.client_event_id } : {}) });
      if (this.state === 'starting') this.finish(false, 'start_rejected');
      return;
    }
    if (e.type === 'session.started') {
      if (this.state !== 'starting' || !object(e.session) || typeof e.session.id !== 'string') { this.finish(false, 'invalid_start'); return; }
      clearTimeout(this.timer); this.state = 'ready'; this.emit({ type: 'ready', sessionId: e.session.id }); return;
    }
    if (this.state === 'starting' || this.state === 'new') { this.finish(false, 'event_before_start'); return; }
    if (e.type === 'session.closed') {
      if (!object(e.usage) || !time(e.usage.seconds) || typeof e.reason !== 'string') { this.finish(false, 'invalid_finalization'); return; }
      this.seconds = e.usage.seconds; this.finish(true, e.reason); return;
    }
    if (e.type === 'session.usage.updated') {
      if (!object(e.usage) || !time(e.usage.seconds)) { this.finish(false, 'invalid_usage'); return; }
      this.seconds = e.usage.seconds; this.emit({ type: 'usage', seconds: this.seconds }); return;
    }
    if (e.type === 'session.output_audio.delta') {
      if (typeof e.delta !== 'string' || e.delta.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.delta)) { this.finish(false, 'invalid_audio'); return; }
      const pcm = Buffer.from(e.delta, 'base64');
      if (pcm.length % 2) { this.finish(false, 'invalid_audio'); return; }
      if (this.state === 'ready') this.emit({ type: 'audio', pcm });
    } else if (e.type === 'session.input_transcript.delta' || e.type === 'session.output_transcript.delta') {
      if (typeof e.delta !== 'string' || !time(e.start_ms) || !time(e.end_ms) || e.end_ms < e.start_ms) { this.finish(false, 'invalid_transcript'); return; }
      this.emit({ type: 'transcript', speaker: e.type === 'session.input_transcript.delta' ? 'user' : 'assistant', delta: e.delta, startMs: e.start_ms, endMs: e.end_ms, ...(typeof e.event_id === 'string' ? { eventId: e.event_id } : {}) });
    } else if (e.type === 'session.delegation.created' && this.state === 'ready') {
      if (!object(e.delegation) || typeof e.delegation.id !== 'string' || e.delegation.target !== this.config.delegation.type || !time(e.offset_ms)) { this.finish(false, 'invalid_delegation'); return; }
      if (this.delegations.has(e.delegation.id)) return;
      if (this.delegations.size >= 1024) { this.finish(false, 'delegation_limit'); return; }
      const target = e.delegation.target as 'client' | 'responses';
      this.delegations.set(e.delegation.id, target);
      this.emit({ type: 'delegation', id: e.delegation.id, target, offsetMs: e.offset_ms });
    } else if (e.type === 'response.event' && typeof e.delegation_id === 'string' && this.delegations.get(e.delegation_id) === 'responses' && object(e.event)) {
      try {
        const result = this.managed.receive(e.delegation_id, e.event);
        if (result) this.emit(result);
      } catch { this.finish(false, 'invalid_managed_response'); }
    } else if ((e.type === 'session.commentary.appended' || e.type === 'session.instructions.appended' || e.type === 'session.thinking.appended') && typeof e.client_event_id === 'string') {
      this.emit({ type: e.type === 'session.commentary.appended' ? 'commentaryAccepted' : e.type === 'session.instructions.appended' ? 'instructionsAccepted' : 'thinkingAccepted', clientEventId: e.client_event_id });
    }
  }
  private finish(complete: boolean, reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed'; clearTimeout(this.timer); this.unsubscribe?.(); this.delegations.clear(); this.managed.clear();
    this.transport.terminate();
    this.emit({ type: 'closed', finalization: complete ? 'complete' : 'incomplete', reason, ...(this.seconds === undefined ? {} : { seconds: this.seconds }) });
  }
}
