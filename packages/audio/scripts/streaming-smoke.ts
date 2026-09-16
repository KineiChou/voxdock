#!/usr/bin/env -S node --import tsx
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { FfmpegResampler, PcmFrameQueue, type PcmRate } from '../src/index.ts';

// Opt-in, synthetic audio only: FFMPEG_PATH=/trusted/ffmpeg node --import tsx packages/audio/scripts/streaming-smoke.ts
const executable = process.env.FFMPEG_PATH ?? 'ffmpeg';
const frames = 75;
const tone = (sample: number, rate: number): number => Math.round(10_000 * Math.sin(2 * Math.PI * 440 * sample / rate));

async function check(inputRate: PcmRate, outputRate: PcmRate): Promise<void> {
  const resampler = new FfmpegResampler({ executable, inputRate, outputRate });
  const queue = new PcmFrameQueue(outputRate, 20, 500);
  const chunks: Buffer[] = [];
  const start = performance.now();
  let firstOutputMs: number | undefined;
  let lastOutputAt: number | undefined;
  let longestOutputGapMs = 0;
  let largestChunkBytes = 0;
  let peakQueueBytes = 0;
  let inputEnded = false;
  let bytesBeforeEnd = 0;
  resampler.on('data', (chunk: Buffer) => {
    try {
      const now = performance.now();
      firstOutputMs ??= now - start;
      if (lastOutputAt !== undefined) longestOutputGapMs = Math.max(longestOutputGapMs, now - lastOutputAt);
      lastOutputAt = now;
      if (!inputEnded) bytesBeforeEnd += chunk.length;
      chunks.push(chunk);
      largestChunkBytes = Math.max(largestChunkBytes, chunk.length);
      queue.push(chunk);
      peakQueueBytes = Math.max(peakQueueBytes, queue.bufferedBytes);
    } catch (error) { resampler.destroy(error as Error); }
  });
  const done = finished(resampler);
  // Attach immediately so failures during paced input cannot become unhandled rejections.
  void done.catch(() => {});
  const playback = setInterval(() => queue.take(true), 20);
  const watchdog = setTimeout(() => resampler.destroy(new Error('Streaming smoke timed out')), 10_000);
  try {
    for (let frame = 0; frame < frames; frame++) {
      const samples = inputRate / 50;
      const pcm = Buffer.alloc(samples * 2);
      for (let sample = 0; sample < samples; sample++) pcm.writeInt16LE(tone(frame * samples + sample, inputRate), sample * 2);
      await new Promise<void>((resolve, reject) => resampler.write(pcm, error => error ? reject(error) : resolve()));
      await delay(20);
    }
    inputEnded = true;
    resampler.end();
    await done;
    assert.ok(bytesBeforeEnd > 0, 'Output must arrive while input is still open');
    assert.ok(firstOutputMs !== undefined && firstOutputMs < 500, `First output took ${firstOutputMs} ms`);
    assert.ok(longestOutputGapMs < 500, `Output stalled for ${longestOutputGapMs} ms`);
    const output = Buffer.concat(chunks);
    assert.equal(output.length % 2, 0, 'Output must end on a complete PCM16 sample');
    assert.equal(output.length, outputRate * frames / 50 * 2, 'Exact output sample count');
    assert.ok(largestChunkBytes <= queue.capacity, 'A single burst exceeds the 500 ms playback queue');
    // Check phase/order as well as byte count; exclude filter boundary transients.
    let squaredError = 0;
    const margin = outputRate / 50;
    const samples = output.length / 2;
    for (let sample = margin; sample < samples - margin; sample++) squaredError += (output.readInt16LE(sample * 2) - tone(sample, outputRate)) ** 2;
    const rmsError = Math.sqrt(squaredError / (samples - 2 * margin));
    assert.ok(rmsError < 100, `Sine phase/order mismatch: RMS error ${rmsError}`);
    console.log(JSON.stringify({ inputRate, outputRate, firstOutputMs: Math.round(firstOutputMs), longestOutputGapMs: Math.round(longestOutputGapMs), bytesBeforeEnd, outputBytes: output.length, largestChunkBytes, peakQueueBytes, rmsError: Math.round(rmsError) }));
  } finally {
    clearInterval(playback); clearTimeout(watchdog); resampler.destroy();
    await done.catch(() => {});
  }
}

await check(48_000, 24_000);
await check(24_000, 48_000);
