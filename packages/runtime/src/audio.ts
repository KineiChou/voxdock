import { performance } from 'node:perf_hooks';
import { PcmFrameQueue, PcmPacer, FfmpegResampler } from '@voxdock/audio';
import type { Duplex } from 'node:stream';
import type { VoiceDriver, RuntimeLive, RuntimeDependencies } from './types.js';

export type AudioFailureReason =
  | 'audio_input_overflow' | 'audio_output_overflow'
  | 'audio_input_resampler_failed' | 'audio_output_resampler_failed'
  | 'audio_live_write_failed' | 'audio_phone_write_failed' | 'audio_phone_write_pending';

/** One paced duplex route; all queues are bounded to 500 ms and overflow ends the call. */
export class CallAudio {
  private readonly input: PcmFrameQueue;
  private readonly output: PcmFrameQueue;
  private readonly inputPacer: PcmPacer;
  private readonly outputPacer: PcmPacer;
  private readonly toLive: Duplex | undefined;
  private readonly toPhone: Duplex | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private writing = false;
  constructor(private readonly voice: VoiceDriver, private readonly ref: string, rate: 16000 | 24000,
    private readonly live: RuntimeLive, private readonly fail: (reason: AudioFailureReason) => void, resampler?: RuntimeDependencies['resampler']) {
    this.input = new PcmFrameQueue(rate, 20, 500);
    this.output = new PcmFrameQueue(voice.rate, voice.frameMs, 500);
    this.inputPacer = new PcmPacer(this.input, pcm => {
      try { this.live.appendAudio(pcm); } catch { this.failed('audio_live_write_failed'); }
    });
    this.outputPacer = new PcmPacer(this.output, pcm => {
      if (this.writing) { this.failed('audio_phone_write_pending'); return; }
      this.writing = true;
      try {
        void this.voice.writeAudio(this.ref, pcm).catch(() => this.failed('audio_phone_write_failed')).finally(() => { this.writing = false; });
      } catch { this.writing = false; this.failed('audio_phone_write_failed'); }
    });
    const factory = resampler ?? ((inputRate, outputRate) => new FfmpegResampler({ inputRate, outputRate, maxBufferedBytes: 48000 }));
    if (voice.rate !== rate) {
      this.toLive = factory(voice.rate, rate); this.toPhone = factory(rate, voice.rate);
      this.toLive.on('data', (pcm: Buffer) => this.enqueue(this.input, pcm, 'audio_input_overflow'));
      this.toPhone.on('data', (pcm: Buffer) => this.enqueue(this.output, pcm, 'audio_output_overflow'));
      this.toLive.on('error', () => this.failed('audio_input_resampler_failed'));
      this.toPhone.on('error', () => this.failed('audio_output_resampler_failed'));
    }
    this.timer = setInterval(() => this.tick(), 5);
  }
  private enqueue(queue: PcmFrameQueue, pcm: Buffer, reason: AudioFailureReason): void {
    if (this.stopped) return;
    try { queue.push(pcm); } catch { this.failed(reason); }
  }
  receive(pcm: Buffer): void {
    if (this.stopped) return;
    if (!this.toLive) { this.enqueue(this.input, pcm, 'audio_input_overflow'); return; }
    try { if (!this.toLive.write(pcm)) this.failed('audio_input_resampler_failed'); }
    catch { this.failed('audio_input_resampler_failed'); }
  }
  play(pcm: Buffer): void {
    if (this.stopped) return;
    if (!this.toPhone) { this.enqueue(this.output, pcm, 'audio_output_overflow'); return; }
    try { if (!this.toPhone.write(pcm)) this.failed('audio_output_resampler_failed'); }
    catch { this.failed('audio_output_resampler_failed'); }
  }
  private tick(): void {
    if (this.stopped) return;
    const now = performance.now();
    this.inputPacer.tick(now);
    if (!this.stopped) this.outputPacer.tick(now);
  }
  private failed(reason: AudioFailureReason): void { if (!this.stopped) { this.close(); this.fail(reason); } }
  close(): void {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer); this.inputPacer.stop(); this.outputPacer.stop(); this.toLive?.destroy(); this.toPhone?.destroy();
  }
}
