import type { Duplex } from 'node:stream';
import type { BridgeConfig } from '@voxdock/config';
import type { BackendContext, CallEvent, CallStatus, Channel, Delegation, DelegationResult } from '@voxdock/contracts';
import type { LiveConfig, LiveEvent } from '@voxdock/live';
export type TargetConfig = BridgeConfig['targets'][number];
export interface VoiceEvents {
  state(ref: string | undefined, state: 'dialing' | 'ringing' | 'connected' | 'ending' | 'ended' | 'uncertain', reason?: 'telegram_media_connect_failed'): void;
  audio(ref: string, pcm: Buffer): void;
  audioReady(ref: string): void;
  incoming(ref: string, allowed: boolean): void;
  fault(): void;
}
export interface VoiceDriver {
  readonly rate: 16000 | 48000;
  readonly frameMs: 10 | 20;
  dial(peerId: string, signal: AbortSignal): Promise<string>;
  accept(ref: string, signal: AbortSignal): Promise<string>;
  reject(ref: string): Promise<void>;
  end(ref: string): Promise<void>;
  writeAudio(ref: string, pcm: Buffer): Promise<void>;
  close(): Promise<void>;
}
export interface RuntimeBackend {
  context(call: CallStatus, principal: string, phase: 'before_dial' | 'before_greeting'): Promise<BackendContext>;
  delegate(delegation: Delegation): Promise<DelegationResult>;
  deliverEvent(event: CallEvent, signal?: AbortSignal): Promise<void>;
}
export interface RuntimeLive {
  start(): void;
  appendAudio(pcm: Uint8Array): void;
  commentary(content: string, delegationId?: string | null): string;
  thinking(content: string, delegationId?: string | null): string;
  instructions(content: string, delegationId?: string | null): string;
  close(): void;
}
export interface RuntimeDependencies {
  backend?: RuntimeBackend;
  voice?: (target: TargetConfig, peerId: string, callbacks: VoiceEvents) => Promise<VoiceDriver>;
  live?: (config: LiveConfig, emit: (event: LiveEvent) => void) => RuntimeLive;
  resampler?: (inputRate: 16000 | 24000 | 48000, outputRate: 16000 | 24000 | 48000) => Duplex;
  secret?: (path: string) => Promise<string>;
  environment?: (name: string) => string | undefined;
}
export interface Runtime {
  readyChannels: Set<Channel>;
  onCallCreated(call: CallStatus): Promise<void>;
  onEnd(call: CallStatus): Promise<void>;
  onResult(result: DelegationResult): Promise<void>;
  close(): Promise<void>;
}
