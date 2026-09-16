import { it, expect } from 'vitest';
import { PcmFrameQueue, PcmPacer, frameBytes, pcmDurationMs } from './index.js';
it('frames odd network chunks without losing sample alignment and bounds memory', () => {
  const q = new PcmFrameQueue(24000, 20, 40);
  q.push(Buffer.alloc(959, 1)); expect(q.take()).toBeUndefined();
  q.push(Buffer.from([2])); expect(q.take()?.at(-1)).toBe(2);
  expect(frameBytes(48000)).toBe(1920);
  expect(pcmDurationMs(Buffer.alloc(960), 24000)).toBe(20);
  expect(() => q.push(Buffer.alloc(1921))).toThrow('backpressure');
});
it('paces silence and media without catchup bursts, releasing retained samples on stop', () => {
  const q = new PcmFrameQueue(16000); const frames: Buffer[] = [];
  const p = new PcmPacer(q, frame => frames.push(frame));
  expect(p.tick(0)).toBe(true); expect(p.tick(1)).toBe(false);
  expect(p.tick(1000)).toBe(true); expect(p.tick(1000)).toBe(false);
  expect(frames).toEqual([Buffer.alloc(640), Buffer.alloc(640)]);
  q.push(Buffer.alloc(10)); p.stop(); expect(q.bufferedBytes).toBe(0); expect(p.tick(2000)).toBe(false);
});
