export interface WhatsAppConnectionConfig { baseUrl: string; sessionId: string; clientId: string; }
export interface WhatsAppSession { paired: boolean; state: string; qr?: string; phone?: string; }
export interface WhatsAppPairing {
  id: string; method: 'message' | 'call'; state: 'waiting' | 'candidate' | 'cancelled' | 'expired'; expires_at: string;
  candidate?: { id: string; phone: string };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const phone = /^\+[1-9][0-9]{6,14}$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The browser cannot select an upstream origin, account, or arbitrary REST path. */
export class WhatsAppConnection {
  private readonly base: URL;
  constructor(private readonly config: WhatsAppConnectionConfig, private readonly transport: typeof fetch = fetch) {
    this.base = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== '/' || !/^[A-Za-z0-9_-]{1,100}$/.test(config.sessionId) || !config.clientId || /[\r\n]/.test(config.clientId)) throw new Error('Invalid WhatsApp connection configuration');
  }
  async request(action: 'status' | 'connect' | 'disconnect'): Promise<WhatsAppSession> {
    const suffix = action === 'status' ? '' : `/${action}`;
    const value = await this.json(suffix, action === 'status' ? 'GET' : 'POST');
    if (!record(value) || typeof value.paired !== 'boolean' || typeof value.state !== 'string') throw new Error('Invalid WhatsApp session status');
    if (action === 'disconnect' && !['disconnected', 'missing'].includes(value.state)) throw new Error('WhatsApp disconnect unconfirmed');
    const qr = typeof value.qr === 'string' && value.qr.length <= 4096 ? value.qr : undefined;
    const ownPhone = typeof value.phone === 'string' && phone.test(value.phone) ? value.phone : undefined;
    return { paired: value.paired, state: value.state, ...(qr ? { qr } : {}), ...(ownPhone ? { phone: ownPhone } : {}) };
  }
  async pairing(action: 'start' | 'status' | 'cancel', id: string, input?: { method: 'message' | 'call'; expires_at: string; code?: string }): Promise<WhatsAppPairing> {
    if (!uuid.test(id) || (action === 'start' && !input)) throw new Error('Invalid WhatsApp pairing request');
    const suffix = `/target-pairing${action === 'start' ? '' : `/${id}${action === 'cancel' ? '/cancel' : ''}`}`;
    const value = await this.json(suffix, action === 'status' ? 'GET' : 'POST', action === 'start' ? { id, ...input } : action === 'cancel' ? {} : undefined);
    if (!record(value) || value.id !== id || !['message', 'call'].includes(String(value.method)) || !['waiting', 'candidate', 'cancelled', 'expired'].includes(String(value.state)) || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) throw new Error('Invalid WhatsApp pairing response');
    if (value.state === 'candidate' && (!record(value.candidate) || typeof value.candidate.id !== 'string' || !uuid.test(value.candidate.id) || typeof value.candidate.phone !== 'string' || !phone.test(value.candidate.phone))) throw new Error('Invalid WhatsApp pairing identity');
    if (action === 'cancel' && value.state !== 'cancelled' && value.state !== 'expired') throw new Error('WhatsApp pairing cancellation unconfirmed');
    return { id, method: value.method as WhatsAppPairing['method'], state: value.state as WhatsAppPairing['state'], expires_at: value.expires_at,
      ...(value.state === 'candidate' ? { candidate: { id: (value.candidate as { id: string }).id, phone: (value.candidate as { phone: string }).phone } } : {}) };
  }
  private async json(suffix: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('WhatsApp request timed out')); }, method === 'GET' ? 3000 : 10000);
      timer.unref();
    });
    try { return await Promise.race([this.perform(suffix, method, controller.signal, body), deadline]); }
    finally { clearTimeout(timer); }
  }
  private async perform(suffix: string, method: 'GET' | 'POST', signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await this.transport(new URL(`/api/voxdock/sessions/${this.config.sessionId}${suffix}`, this.base), {
      method, redirect: 'error', signal,
      headers: { 'X-Client-Id': this.config.clientId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('WhatsApp connection request failed'); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 65536) throw new Error('WhatsApp response exceeds limit');
        chunks.push(result.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
}
