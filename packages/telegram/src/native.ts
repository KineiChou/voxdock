import { StreamMode, StreamDevice, MediaSource, ConnectionState, VideoRotation, type RTCServer } from 'ntgcalls';
import { Api } from 'teleproto';
import { TelegramNativeBinding } from './binding.ts';

export function rtcServers(connections: Api.TypePhoneConnection[]): RTCServer[] {
  return connections.map(c => {
    const common = { id: BigInt(c.id.toString()), ipv4: c.ip, ipv6: c.ipv6, port: c.port };
    if (c instanceof Api.PhoneConnectionWebrtc) return { ...common, username: c.username, password: c.password, turn: Boolean(c.turn), stun: Boolean(c.stun), tcp: false };
    if (c instanceof Api.PhoneConnection) return { ...common, turn: true, stun: false, tcp: Boolean(c.tcp), peerTag: c.peerTag };
    throw new Error('Unsupported Telegram relay');
  });
}

/** PCM16LE, 48 kHz, mono. Caller supplies paced 10 ms frames, with bounded queues. */
export class TelegramMedia {
  readonly native: TelegramNativeBinding;
  private active = true;
  private ready = false;
  private writing = false;
  private stopping?: Promise<void>;
  private connected = false;
  private configured = false;
  private readonly onReady: () => void;
  private readonly userId: bigint;
  private readonly onFailure: () => void;
  constructor(userId: bigint, callbacks: { onReady: () => void; onAudio: (pcm: Buffer) => void; onFailure: () => void }, native = new TelegramNativeBinding()) {
    this.native = native; this.userId = userId; this.onFailure = callbacks.onFailure; this.onReady = callbacks.onReady;
    native.onConnectionChange((id, info) => {
      if (!this.active || id !== userId) return;
      if (info.state === ConnectionState.CONNECTED) { this.connected = true; this.markReady(); }
      else if ([ConnectionState.FAILED, ConnectionState.TIMEOUT, ConnectionState.CLOSED].includes(info.state)) this.fail();
    });
    native.onFrames((id, mode, device, frames) => {
      if (!this.active || id !== userId || mode !== StreamMode.PLAYBACK || device !== StreamDevice.MICROPHONE) return;
      for (const frame of frames) {
        if (frame.data.length !== 960) { this.fail(); return; }
        callbacks.onAudio(Buffer.from(frame.data));
      }
    });
  }
  async create(): Promise<void> {
    await this.native.createP2pCall(this.userId);
    await this.native.setStreamSources(this.userId, StreamMode.CAPTURE, { microphone: {
      mediaSource: MediaSource.EXTERNAL, sampleRate: 48000, channelCount: 1, input: '', keepOpen: true,
    } });
  }
  async connect(call: Api.PhoneCall): Promise<void> {
    await this.native.connectP2p(this.userId, rtcServers(call.connections), call.protocol.libraryVersions, Boolean(call.p2pAllowed), call.customParameters?.data ?? null);
    await this.native.setStreamSources(this.userId, StreamMode.PLAYBACK, { microphone: {
      mediaSource: MediaSource.EXTERNAL, sampleRate: 48000, channelCount: 1, input: '', keepOpen: true,
    } });
    this.configured = true; this.markReady();
  }
  private markReady(): void {
    if (this.active && this.connected && this.configured && !this.ready) { this.ready = true; this.onReady(); }
  }
  async write(pcm: Buffer): Promise<void> {
    if (!this.active || !this.ready) throw new Error('Telegram media is not ready');
    if (pcm.length !== 960 || this.writing) { this.fail(); throw new Error('Expected one paced 10 ms PCM frame'); }
    this.writing = true;
    try {
      await this.native.sendExternalFrame(this.userId, StreamDevice.MICROPHONE, pcm, {
        absoluteCaptureTimestampMs: 0n, rotation: VideoRotation.VIDEO_ROTATION_0, width: 0, height: 0,
      });
    } catch { this.fail(); throw new Error('Telegram audio send failed'); }
    finally { this.writing = false; }
  }
  async close(): Promise<void> {
    this.active = false; this.ready = false;
    this.stopping ??= this.native.stop(this.userId);
    await this.stopping;
  }
  private fail(): void { if (this.active) { this.active = false; this.ready = false; this.onFailure(); } }
}
