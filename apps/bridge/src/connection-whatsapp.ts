export interface WhatsAppConnectionConfig { baseUrl: string; sessionId: string; clientId: string; }
export interface WhatsAppSession { paired: boolean; state: string; qr?: string; }
/** The browser cannot select an upstream origin, account, or arbitrary REST path. */
export class WhatsAppConnection {
  private readonly base: URL;
  constructor(private readonly config: WhatsAppConnectionConfig, private readonly transport: typeof fetch = fetch) {
    this.base = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== '/' || !/^[A-Za-z0-9_-]{1,100}$/.test(config.sessionId) || !config.clientId || /[\r\n]/.test(config.clientId)) throw new Error('Invalid WhatsApp connection configuration');
  }
  async request(action: 'status' | 'connect' | 'disconnect'): Promise<WhatsAppSession> {
    const suffix = action === 'status' ? '' : `/${action}`;
    const response = await this.transport(new URL(`/api/voxdock/sessions/${this.config.sessionId}${suffix}`, this.base), {
      method: action === 'status' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'X-Client-Id': this.config.clientId },
    });
    if (!response.ok) throw new Error('WhatsApp connection request failed');
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('paired' in value) || typeof value.paired !== 'boolean' || !('state' in value) || typeof value.state !== 'string') throw new Error('Invalid WhatsApp session status');
    if (action === 'disconnect' && !['disconnected', 'missing'].includes(value.state)) throw new Error('WhatsApp disconnect unconfirmed');
    const qr = 'qr' in value && typeof value.qr === 'string' && value.qr.length <= 4096 ? value.qr : undefined;
    return { paired: value.paired, state: value.state, ...(qr ? { qr } : {}) };
  }
}
