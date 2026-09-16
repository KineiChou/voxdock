import { expect, test, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { CallAudio } from './audio.js';
import type { RuntimeLive, VoiceDriver } from './types.js';

test('quiet or DTX calls keep paced silence until the platform ends them', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  const input = vi.fn();
  const fail = vi.fn();
  const voice: VoiceDriver = {
    rate: 16000, frameMs: 20,
    dial: async () => 'call', accept: async ref => ref, reject: async () => {},
    end: async () => {}, close: async () => {}, writeAudio: async () => {},
  };
  const live: RuntimeLive = {
    start() {}, appendAudio: input, close() {},
    commentary: () => 'c', instructions: () => 'i', thinking: () => 't',
  };
  const audio = new CallAudio(voice, 'call', 16000, live, fail);
  try {
    await vi.advanceTimersByTimeAsync(1800);
    expect(fail).not.toHaveBeenCalled();
    expect(input.mock.calls.length).toBeGreaterThan(50);
    expect(input.mock.calls.every(([pcm]) => pcm.equals(Buffer.alloc(640)))).toBe(true);
  } finally { audio.close(); vi.restoreAllMocks(); vi.useRealTimers(); }
});
