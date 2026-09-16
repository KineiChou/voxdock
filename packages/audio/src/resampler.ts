import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import { frameBytes, type PcmRate } from './index.js';

export type ResamplerSpawn = (executable: string, args: readonly string[]) => ChildProcessWithoutNullStreams;
export interface ResamplerOptions {
  executable?: string;
  inputRate: PcmRate;
  outputRate: PcmRate;
  maxBufferedBytes?: number;
  finishTimeoutMs?: number;
  spawnProcess?: ResamplerSpawn;
}

/** One process per direction. Stream consumers must honor write() and readable backpressure. */
export class FfmpegResampler extends Duplex {
  private readonly child: ChildProcessWithoutNullStreams;
  private trailing = Buffer.alloc(0);
  private outputEnded = false;
  private finishTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly limit: number;
  private readonly finishTimeout: number;
  constructor(options: ResamplerOptions) {
    const limit = options.maxBufferedBytes ?? 96000;
    const finishTimeout = options.finishTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(limit) || limit < 1920 || !Number.isSafeInteger(finishTimeout) || finishTimeout <= 0) throw new Error('Invalid resampler limits');
    frameBytes(options.inputRate); frameBytes(options.outputRate);
    super({ readableHighWaterMark: limit, writableHighWaterMark: limit });
    this.limit = limit; this.finishTimeout = finishTimeout;
    this.child = (options.spawnProcess ?? ((file, args) => spawn(file, args, { stdio: 'pipe' })))(options.executable ?? 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 's16le', '-ar', String(options.inputRate), '-ac', '1', '-i', 'pipe:0',
      '-f', 's16le', '-ar', String(options.outputRate), '-ac', '1', 'pipe:1',
    ]);
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.length > this.limit || this.readableLength + chunk.length > this.limit) {
        this.destroy(new Error('Resampler output backpressure exceeded')); return;
      }
      if (!this.push(chunk)) this.child.stdout.pause();
    });
    this.child.stdout.on('end', () => { this.outputEnded = true; });
    this.child.stderr.resume();
    this.child.on('error', () => this.destroy(new Error('Resampler process failed')));
    this.child.stdin.on('error', () => this.destroy(new Error('Resampler input failed')));
    this.child.stdout.on('error', () => this.destroy(new Error('Resampler output failed')));
    this.child.on('close', code => {
      clearTimeout(this.finishTimer);
      if (code !== 0 || !this.writableEnded || !this.outputEnded) { this.destroy(new Error('Resampler exited unsuccessfully')); return; }
      this.push(null);
    });
  }
  override write(chunk: Uint8Array | string, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    if (this.writableLength + bytes > this.limit) {
      const error = new Error('Resampler input backpressure exceeded');
      if (done) queueMicrotask(() => done(error));
      this.destroy(error); return false;
    }
    return encoding === undefined ? super.write(chunk, done) : super.write(chunk, encoding, done);
  }
  override _read(): void { this.child.stdout.resume(); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.writableLength > this.limit) { callback(new Error('Resampler input backpressure exceeded')); return; }
    if (chunk.length > this.limit) { callback(new Error('Resampler input chunk too large')); return; }
    const bytes = Buffer.concat([this.trailing, chunk]);
    const length = bytes.length - bytes.length % 2;
    this.trailing = Buffer.from(bytes.subarray(length));
    if (!length) { callback(); return; }
    this.child.stdin.write(bytes.subarray(0, length), callback);
  }
  override _final(callback: (error?: Error | null) => void): void {
    if (this.trailing.length) { callback(new Error('Incomplete final PCM16 sample')); return; }
    this.finishTimer = setTimeout(() => this.destroy(new Error('Resampler finish timeout')), this.finishTimeout);
    this.child.stdin.end(callback);
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.finishTimer); this.trailing = Buffer.alloc(0);
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    this.child.kill('SIGKILL'); callback(error);
  }
}
