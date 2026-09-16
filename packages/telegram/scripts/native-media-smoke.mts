import assert from 'node:assert/strict';
import { StreamMode, MediaSource, StreamDevice, VideoRotation } from 'ntgcalls';
import { TelegramNativeBinding } from '../src/binding.ts';
// Synthetic parameters exercise the byte ABI only. Never use these as call DH parameters.
const native = new TelegramNativeBinding();
await native.createP2pCall(1n);
try {
  const hash = await native.initExchange(1n, { g: 3, p: Buffer.alloc(256, 255), random: Buffer.alloc(256, 1) }, null);
  assert.equal(hash.length, 32);
  await native.setStreamSources(1n, StreamMode.CAPTURE, { microphone: {
    mediaSource: MediaSource.EXTERNAL, sampleRate: 48000, channelCount: 1, input: '', keepOpen: true,
  } });
  await native.sendExternalFrame(1n, StreamDevice.MICROPHONE, Buffer.alloc(960), {
    absoluteCaptureTimestampMs: 0n, rotation: VideoRotation.VIDEO_ROTATION_0, width: 0, height: 0,
  });
} finally { await native.stop(1n); }
console.log('Native create, byte ABI, external PCM and cleanup smoke passed; no account or call used.');
