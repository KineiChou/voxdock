import { performance } from 'node:perf_hooks';
import { PcmFrameQueue, FfmpegResampler } from '@voxdock/audio';
import type { Duplex } from 'node:stream';
import type { VoiceDriver, RuntimeLive, RuntimeDependencies } from './types.js';

/** One paced duplex route; all queues are bounded to 500 ms and overflow ends the call. */
export class CallAudio {
  private readonly input: PcmFrameQueue;
  private readonly output: PcmFrameQueue;
  private readonly toLive: Duplex | undefined;
  private readonly toPhone: Duplex | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private writing = false;
  private nextLive = performance.now();
  private nextPhone = performance.now();
  private lastInput = performance.now();
  constructor(private readonly voice: VoiceDriver, private readonly ref: string, rate: 16000 | 24000,
    private readonly live: RuntimeLive, private readonly fail: () => void, resampler?: RuntimeDependencies['resampler']) {
    this.input = new PcmFrameQueue(rate, 20, 500);
    this.output = new PcmFrameQueue(voice.rate, voice.frameMs, 500);
    const factory = resampler ?? ((inputRate, outputRate) => new FfmpegResampler({ inputRate, outputRate, maxBufferedBytes: 48000 }));
    if (voice.rate !== rate) {
      this.toLive = factory(voice.rate, rate); this.toPhone = factory(rate, voice.rate);
      this.toLive.on('data', (pcm: Buffer) => { try { this.input.push(pcm); } catch { this.failed(); } });
      this.toPhone.on('data', (pcm: Buffer) => { try { this.output.push(pcm); } catch { this.failed(); } });
      this.toLive.on('error', () => this.failed()); this.toPhone.on('error', () => this.failed());
    }
    this.timer = setInterval(() => this.tick(), 5);
  }
  receive(pcm: Buffer): void {
    if (this.stopped) return;
    this.lastInput = performance.now();
    try { if (this.toLive) { if (!this.toLive.write(pcm)) this.failed(); } else this.input.push(pcm); } catch { this.failed(); }
  }
  play(pcm: Buffer): void {
    if (this.stopped) return;
    try { if (this.toPhone) { if (!this.toPhone.write(pcm)) this.failed(); } else this.output.push(pcm); } catch { this.failed(); }
  }
  private tick(): void {
    if (this.stopped) return;
    const now = performance.now();
    if (now - this.lastInput > 1500) { this.failed(); return; }
    try {
      if (now >= this.nextLive) { this.nextLive = now + 20; this.live.appendAudio(this.input.take(true)!); }
      if (now >= this.nextPhone) {
        if (this.writing) { this.failed(); return; }
        this.nextPhone = now + this.voice.frameMs; this.writing = true;
        void this.voice.writeAudio(this.ref, this.output.take(true)!).catch(() => this.failed()).finally(() => { this.writing = false; });
      }
    } catch { this.failed(); }
  }
  private failed(): void { if (!this.stopped) { this.close(); this.fail(); } }
  close(): void {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer); this.input.clear(); this.output.clear(); this.toLive?.destroy(); this.toPhone?.destroy();
  }
}
