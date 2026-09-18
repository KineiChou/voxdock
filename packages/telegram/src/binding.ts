import { NTgCalls, type DhConfig, type FrameData, type StreamDevice, type RTCServer } from 'ntgcalls';

// The pinned rc03 addon accepts JS arrays for byte inputs, despite declaring Buffer.
// Outgoing initExchange requires null, not an empty byte sequence. Keep that
// verified ABI boundary here; application code uses Buffer throughout.
function bytes(value: Buffer): Buffer { return Array.from(value) as unknown as Buffer; }
export class TelegramNativeBinding extends NTgCalls {
  override initExchange(id: bigint, config: DhConfig, hash: Buffer | null): Promise<Buffer> {
    return super.initExchange(id, { ...config, p: bytes(config.p), random: bytes(config.random) }, hash === null ? null as unknown as Buffer : bytes(hash));
  }
  override exchangeKeys(id: bigint, value: Buffer, fingerprint: bigint) {
    return super.exchangeKeys(id, bytes(value), fingerprint);
  }
  override sendSignalingData(id: bigint, value: Buffer): Promise<void> {
    return super.sendSignalingData(id, bytes(value));
  }
  override sendExternalFrame(id: bigint, device: StreamDevice, value: Buffer, metadata: FrameData): Promise<void> {
    return super.sendExternalFrame(id, device, bytes(value), metadata);
  }
  // rc03 accepts optional custom JSON as native null, despite declaring string.
  override connectP2p(id: bigint, servers: RTCServer[], versions: string[], p2p: boolean, parameters: string | null): Promise<void> {
    return super.connectP2p(id, servers.map(server => ({ ...server, ...(server.peerTag ? { peerTag: bytes(server.peerTag) } : {}) })), versions, p2p, parameters as string);
  }
}
