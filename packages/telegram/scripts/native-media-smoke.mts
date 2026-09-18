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
// Empty protocol versions fail after JSON parsing but before NativeConnection
// construction in pinned rc03. This exercises the real binding boundary
// without opening any network connection, even when parsing succeeds.
await native.createP2pCall(2n);
try {
  // skipExchange is only used in this synthetic check; rc03 byte inputs are arrays.
  await native.skipExchange(2n, Array(256).fill(1) as unknown as Buffer, false);
  for (const parameters of [null, '{"network_use_default_route":true}', 'null', '']) {
    await assert.rejects(native.connectP2p(2n, [], [], false, parameters), parameters === '' ? /incomplete JSON/ : /No versions provided/);
  }
} finally { await native.stop(2n); }
console.log('Native create, byte ABI, external PCM, optional JSON and cleanup smoke passed; no account, network connection or call used.');
