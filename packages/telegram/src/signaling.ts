import type { NTgCalls } from 'ntgcalls';

export interface TelegramSignalTransport {
  send(callId: bigint, accessHash: bigint, data: Buffer): Promise<void>;
}

/** One instance owns one native child process and one bound platform call. */
export class TelegramSignaling {
  private active = true;
  private pending = 0;
  private outbound = Promise.resolve();
  private readonly native: Pick<NTgCalls, 'onSignalingData' | 'sendSignalingData'>;
  private readonly transport: TelegramSignalTransport;
  private readonly userId: bigint;
  private readonly callId: bigint;
  private readonly accessHash: bigint;
  private readonly onFailure: () => void;

  constructor(options: {
    native: Pick<NTgCalls, 'onSignalingData' | 'sendSignalingData'>;
    transport: TelegramSignalTransport;
    userId: bigint; callId: bigint; accessHash: bigint;
    onFailure: () => void;
  }) {
    this.native = options.native; this.transport = options.transport;
    this.userId = options.userId; this.callId = options.callId; this.accessHash = options.accessHash;
    this.onFailure = options.onFailure;
    this.native.onSignalingData((id, data) => {
      if (!this.active || id !== this.userId) return;
      if (data.byteLength > 65536 || ++this.pending > 32) { this.fail(); return; }
      const copy = Buffer.from(data);
      this.outbound = this.outbound.then(async () => {
        if (this.active) await this.transport.send(this.callId, this.accessHash, copy);
      }).catch(() => this.fail()).finally(() => { this.pending--; });
    });
  }

  async receive(callId: bigint, data: Buffer): Promise<void> {
    if (!this.active || callId !== this.callId) return;
    if (data.byteLength > 65536) { this.fail(); return; }
    try { await this.native.sendSignalingData(this.userId, Buffer.from(data)); }
    catch { this.fail(); }
  }

  close(): void { this.active = false; }
  private fail(): void {
    if (!this.active) return;
    this.active = false;
    this.onFailure();
  }
}
