import { expect, test, vi } from 'vitest';
import { Api } from 'teleproto';
import bigInt from 'big-integer';
import { TelegramMedia } from './native.ts';
import type { TelegramNativeBinding } from './binding.ts';

function fixture() {
  const native = { onConnectionChange: vi.fn(), onFrames: vi.fn(), connectP2p: vi.fn(async () => {}), setStreamSources: vi.fn(async () => {}) };
  const media = new TelegramMedia(2n, { onReady: vi.fn(), onAudio: vi.fn(), onFailure: vi.fn() }, native as unknown as TelegramNativeBinding);
  return { native, media };
}

test.each([undefined, '{"network_use_default_route":true}', 'null'])('preserves native absence and provided custom JSON: %s', async parameters => {
  const { native, media } = fixture();
  const call = new Api.PhoneCall({ id: bigInt(10), accessHash: bigInt(20), date: 1, adminId: bigInt(1), participantId: bigInt(2),
    gAOrB: Buffer.alloc(256), keyFingerprint: bigInt(99), connections: [], startDate: 1,
    protocol: new Api.PhoneCallProtocol({ minLayer: 92, maxLayer: 92, libraryVersions: ['13.0.0'] }),
    ...(parameters === undefined ? {} : { customParameters: new Api.DataJSON({ data: parameters }) }),
  });
  await media.connect(call);
  expect(native.connectP2p).toHaveBeenCalledWith(2n, [], ['13.0.0'], false, parameters ?? null);
  expect(native.setStreamSources).toHaveBeenCalledOnce();
});
