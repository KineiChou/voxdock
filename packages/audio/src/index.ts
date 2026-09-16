export type PcmRate = 16000 | 24000 | 48000;

export function frameBytes(rate: PcmRate, durationMs = 20): number {
  const samples = rate * durationMs / 1000;
  if (![16000, 24000, 48000].includes(rate) || !Number.isSafeInteger(samples) || samples <= 0) {
    throw new Error('Invalid PCM frame duration or sample rate');
  }
  return samples * 2;
}

export function pcmDurationMs(pcm: Uint8Array, rate: PcmRate): number {
  frameBytes(rate);
  if (pcm.byteLength % 2) throw new Error('PCM16 requires complete samples');
  return pcm.byteLength / 2 / rate * 1000;
}

/** A bounded mono PCM16 queue. Overflow is explicit, never silently discarded. */
export class PcmFrameQueue {
  private pending = Buffer.alloc(0);
  readonly bytesPerFrame: number;
  readonly capacity: number;
  constructor(readonly rate: PcmRate, readonly durationMs = 20, maxBufferedMs = 500) {
    this.bytesPerFrame = frameBytes(rate, durationMs);
    this.capacity = frameBytes(rate, maxBufferedMs);
    if (this.capacity < this.bytesPerFrame) throw new Error('Buffer shorter than frame');
  }
  get bufferedBytes(): number { return this.pending.length; }
  push(bytes: Uint8Array): void {
    if (this.pending.length + bytes.byteLength > this.capacity) throw new Error('Audio backpressure');
    this.pending = Buffer.concat([this.pending, bytes]);
  }
  take(silenceOnUnderrun = false): Buffer | undefined {
    if (this.pending.length < this.bytesPerFrame) {
      if (!silenceOnUnderrun) return undefined;
      // Preserve a possible half sample for the next chunk.
      const complete = this.pending.length - this.pending.length % 2;
      const frame = Buffer.alloc(this.bytesPerFrame);
      this.pending.copy(frame, 0, 0, complete);
      this.pending = Buffer.from(this.pending.subarray(complete));
      return frame;
    }
    const frame = Buffer.from(this.pending.subarray(0, this.bytesPerFrame));
    this.pending = Buffer.from(this.pending.subarray(this.bytesPerFrame));
    return frame;
  }
  clear(): void { this.pending = Buffer.alloc(0); }
}

/** Caller ticks with a monotonic clock. At most one frame per tick; no catch-up bursts. */
export class PcmPacer {
  private due: number | undefined;
  private stopped = false;
  constructor(readonly queue: PcmFrameQueue, private readonly send: (frame: Buffer) => void) {}
  tick(nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) throw new Error('Invalid clock');
    if (this.stopped || (this.due !== undefined && nowMs < this.due)) return false;
    this.send(this.queue.take(true)!);
    // Ordinary timer lateness must not change the nominal sample clock.
    // After a missed slot, restart from now instead of sending catch-up frames.
    const next = (this.due ?? nowMs) + this.queue.durationMs;
    this.due = next > nowMs ? next : nowMs + this.queue.durationMs;
    return true;
  }
  stop(): void { this.stopped = true; this.queue.clear(); }
}

export { FfmpegResampler, type ResamplerOptions, type ResamplerSpawn } from './resampler.js';
