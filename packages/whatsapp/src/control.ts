export function normalizePhone(value: string): string {
  if (!/^\+?[1-9][0-9]{6,14}$/.test(value)) throw new Error('Expected an international phone number');
  return value.replace(/^\+/, '');
}

export interface WaCallsOptions {
  baseUrl: string;
  sessionId: string;
  clientId: string;
  ownPhone: string;
  targetPhone: string;
  fetch?: typeof fetch;
}

/** Operator-configured internal origin: upstream has no authentication. */
export class WaCallsControl {
  private readonly options: WaCallsOptions;
  private readonly transport: typeof fetch;
  private readonly base: URL;
  readonly targetPhone: string;

  constructor(options: WaCallsOptions) {
    this.options = options;
    this.base = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(this.base.protocol) ||
        this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== '/') {
      throw new Error('WaCalls requires a fixed HTTP(S) origin');
    }
    if (!options.sessionId || !options.clientId || /[\r\n]/.test(options.clientId)) throw new Error('Session and client binding required');
    this.targetPhone = normalizePhone(options.targetPhone);
    if (this.targetPhone === normalizePhone(options.ownPhone)) throw new Error('Caller and target must differ');
    this.transport = options.fetch ?? fetch;
  }

  private async request(path: string, method: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    const response = await this.transport(new URL(path, this.base), {
      method, signal, redirect: 'error',
      headers: { 'X-Client-Id': this.options.clientId, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`WaCalls request failed (${response.status}); reconcile before retrying`);
    return response;
  }

  private calls(): string { return `/api/sessions/${encodeURIComponent(this.options.sessionId)}/calls`; }

  /** Caller must durably reserve the call before invoking; never automatically retry. */
  async dial(signal: AbortSignal): Promise<string> {
    const response = await this.request(this.calls(), 'POST', signal, { phone: this.targetPhone, record: false });
    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.call) || typeof value.call.callId !== 'string' || !value.call.callId) {
      throw new Error('WaCalls returned an invalid call identity; outcome is uncertain');
    }
    return value.call.callId;
  }

  async end(callId: string, signal: AbortSignal): Promise<void> {
    if (!callId) throw new Error('Call identity required');
    await this.request(`${this.calls()}/${encodeURIComponent(callId)}`, 'DELETE', signal);
  }

  async events(signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const response = await this.request('/api/events', 'GET', signal);
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('Expected WaCalls event stream');
    return response.body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type WaCallsEvent = { sessionId: string; callId: string; state: 'dialing' | 'connected' | 'ended'; reason?: string };

/** Upstream's "ringing" is optimistic local creation, not remote ringing evidence. */
export function parseCallEvent(data: string, sessionId: string, callId: string): WaCallsEvent | undefined {
  const event: unknown = JSON.parse(data);
  if (!isRecord(event)) throw new Error('Invalid WaCalls event');
  if (event.type !== 'call-status' && event.type !== 'call-ended') return undefined;
  if (typeof event.sessionId !== 'string' || typeof event.id !== 'string') throw new Error('Missing event identity');
  if (event.sessionId !== sessionId || event.id !== callId) return undefined;
  if (event.type === 'call-ended') {
    if (typeof event.reason !== 'string') throw new Error('Missing end reason');
    return { sessionId, callId, state: 'ended', reason: event.reason };
  }
  if (!['starting', 'ringing', 'connected', 'ended'].includes(String(event.status))) throw new Error('Unknown call status');
  return { sessionId, callId, state: event.status === 'connected' ? 'connected' : event.status === 'ended' ? 'ended' : 'dialing' };
}
