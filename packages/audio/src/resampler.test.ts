import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { FfmpegResampler } from './resampler.js';
function fake() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  return { child, spawn };
}
it('keeps one FFmpeg pipe, describes actual sample formats, and preserves partial samples', async () => {
  const { child, spawn } = fake();
  const stream = new FfmpegResampler({ inputRate: 48000, outputRate: 24000, spawnProcess: spawn });
  const written: Buffer[] = []; child.stdin.on('data', b => written.push(b));
  stream.write(Buffer.from([1])); stream.write(Buffer.from([2, 3, 4]));
  expect(Buffer.concat(written)).toEqual(Buffer.from([1, 2, 3, 4]));
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0]).toEqual(['ffmpeg', expect.arrayContaining(['48000', '24000', 's16le', 'pipe:0', 'pipe:1'])]);
  stream.resume(); const ended = once(stream, 'end');
  stream.end(); const outputEnd = once(child.stdout, 'end'); child.stdout.end(Buffer.alloc(4)); await outputEnd; child.emit('close', 0); await ended;
});
it('rejects partial final samples and kills failed children', async () => {
  const { child, spawn } = fake();
  const stream = new FfmpegResampler({ inputRate: 24000, outputRate: 48000, spawnProcess: spawn });
  const error = once(stream, 'error'); stream.end(Buffer.from([1]));
  expect((await error)[0].message).toBe('Incomplete final PCM16 sample');
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});
it('rejects oversized input and output without retaining unbounded media', async () => {
  const a = fake(); const input = new FfmpegResampler({ inputRate: 24000, outputRate: 48000, maxBufferedBytes: 1920, spawnProcess: a.spawn });
  const e1 = once(input, 'error'); input.write(Buffer.alloc(1921)); await e1;
  const b = fake(); const output = new FfmpegResampler({ inputRate: 48000, outputRate: 24000, maxBufferedBytes: 1920, spawnProcess: b.spawn });
  const e2 = once(output, 'error'); b.child.stdout.write(Buffer.alloc(1921)); await e2;
  expect(a.child.kill).toHaveBeenCalled(); expect(b.child.kill).toHaveBeenCalled();
});
