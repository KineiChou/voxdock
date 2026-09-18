import { randomBytes } from 'node:crypto';
import { Api, type TelegramClient } from 'teleproto';
import bigInt from 'big-integer';
import { NTgCalls } from 'ntgcalls';
import { bindTelegramTarget, telegramUserId } from './identity.ts';
import { TelegramMedia } from './native.ts';
import { TelegramSignaling } from './signaling.ts';
import { telegramSignalTransport } from './transport.ts';

export type TelegramCallState = 'dialing' | 'ringing' | 'connected' | 'ending' | 'ended' | 'uncertain';
export type TelegramFailureReason = 'telegram_media_connect_failed';
export interface TelegramCallbacks {
  onState: (ref: string | undefined, state: TelegramCallState, reason?: TelegramFailureReason) => void;
  onAudio: (ref: string, pcm: Buffer) => void;
  onAudioReady: (ref: string) => void;
  onIncoming: (ref: string, allowed: boolean) => void;
}
interface ActiveCall {
  media: TelegramMedia;
  peer?: Api.InputPhoneCall;
  signal?: TelegramSignaling;
  queuedSignals: Buffer[];
  queuedCalls: Api.TypePhoneCall[];
  confirmed: boolean;
  incoming: boolean;
  connected: boolean;
  ending: boolean;
  uncertain: boolean;
  abort?: () => void;
  discard?: Promise<void>;
}

/** One configured user target and one in-process call. Durable admission belongs to the host. */
export class TelegramDriver {
  private readonly client: TelegramClient;
  private readonly target: bigint;
  private readonly account: bigint;
  private readonly callbacks: TelegramCallbacks;
  private active: ActiveCall | undefined;
  private incoming = new Map<string, Api.PhoneCallRequested>();
  private updates = Promise.resolve();
  private readonly removeHandlers: Array<() => void>;

  constructor(client: TelegramClient, accountId: string, targetId: string, callbacks: TelegramCallbacks) {
    this.client = client; this.account = BigInt(accountId); this.target = bindTelegramTarget(accountId, targetId); this.callbacks = callbacks;
    this.removeHandlers = [
      client.updates.on('phoneCall', update => {
        this.updates = this.updates.then(() => this.handleCall(update.phoneCall)).catch(() => this.fail());
      }),
      client.updates.on('phoneCallSignalingData', update => {
        this.updates = this.updates.then(async () => {
          const active = this.active;
          if (!active || active.ending || active.uncertain || active.peer?.id.toString() !== update.phoneCallId.toString()) return;
          if (active.signal) await active.signal.receive(BigInt(update.phoneCallId.toString()), update.data);
          else if (active.queuedSignals.length < 32 && update.data.length <= 65536) active.queuedSignals.push(Buffer.from(update.data));
          else this.fail();
        }).catch(() => this.fail());
      }),
    ];
  }

  async dial(targetId: string, signal: AbortSignal): Promise<string> {
    if (telegramUserId(targetId) !== this.target) throw new Error('Unconfigured Telegram target');
    if (this.active) throw new Error('Telegram call already reserved; reconcile uncertain calls before dialing');
    signal.throwIfAborted();
    const me = await this.client.getMe();
    if (!(me instanceof Api.User) || me.bot || me.id.toString() !== this.account.toString()) throw new Error('Telegram account binding mismatch');
    // Reserve before any asynchronous call setup so a second dial cannot race it.
    if (this.active) throw new Error('Telegram call already reserved');
    const active = this.reserve(signal, false);
    try {
      const target = await this.client.getInputEntity(bigInt(this.target.toString()));
      if (!(target instanceof Api.InputPeerUser) || target.userId.toString() !== this.target.toString()) throw new Error('Target is not a resolved user');
      const config = await this.client.invoke(new Api.messages.GetDhConfig({ version: 0, randomLength: 256 }));
      if (!(config instanceof Api.messages.DhConfig)) throw new Error('Expected complete Telegram DH configuration');
      signal.throwIfAborted();
      await active.media.create();
      const hash = await active.media.native.initExchange(this.target, { g: config.g, p: config.p, random: config.random }, null);
      signal.throwIfAborted();
      if (active.uncertain) throw new Error('Call setup interrupted');
      this.callbacks.onState(undefined, 'dialing');
      const response = await this.client.invoke(new Api.phone.RequestCall({
        userId: new Api.InputUser({ userId: target.userId, accessHash: target.accessHash }),
        randomId: randomBytes(4).readInt32LE(), gAHash: hash, protocol: this.protocol(), video: false,
      }));
      if (!('accessHash' in response.phoneCall)) throw new Error('No call reference in Telegram response');
      const call = response.phoneCall;
      active.peer = new Api.InputPhoneCall({ id: call.id, accessHash: call.accessHash });
      if (active.uncertain || signal.aborted) { await this.end(call.id.toString()); throw new Error('Call setup interrupted after request'); }
      await this.handleCall(call);
      for (const queued of active.queuedCalls) await this.handleCall(queued);
      active.queuedCalls = [];
      return call.id.toString();
    } catch {
      this.fail();
      throw new Error('Telegram dial did not complete; reconcile before retrying');
    }
  }

  private reserve(signal: AbortSignal, incoming: boolean): ActiveCall {
    const active: ActiveCall = {
      media: new TelegramMedia(this.target, {
        onReady: () => { if (this.active === active && active.peer && !active.ending && !active.uncertain) this.callbacks.onAudioReady(active.peer.id.toString()); },
        onAudio: pcm => { if (this.active === active && active.peer && !active.ending && !active.uncertain) this.callbacks.onAudio(active.peer.id.toString(), pcm); },
        onFailure: () => { if (this.active === active) this.fail(); },
      }), queuedSignals: [], queuedCalls: [], confirmed: false, incoming, connected: false, ending: false, uncertain: false,
    };
    this.active = active;
    const abort = () => { if (this.active === active) { if (active.peer) void this.end(active.peer.id.toString()); else this.fail(); } };
    signal.addEventListener('abort', abort, { once: true });
    active.abort = () => signal.removeEventListener('abort', abort);
    return active;
  }

  async accept(ref: string, signal: AbortSignal): Promise<string> {
    if (this.active) throw new Error('Telegram call already reserved');
    signal.throwIfAborted();
    const offered = this.incoming.get(ref);
    if (!offered || offered.video || offered.adminId.toString() !== this.target.toString() || offered.participantId.toString() !== this.account.toString()) throw new Error('Unapproved incoming caller');
    const active = this.reserve(signal, true);
    active.peer = new Api.InputPhoneCall({ id: offered.id, accessHash: offered.accessHash });
    this.incoming.delete(ref);
    try {
      const config = await this.client.invoke(new Api.messages.GetDhConfig({ version: 0, randomLength: 256 }));
      if (!(config instanceof Api.messages.DhConfig)) throw new Error('Expected complete DH configuration');
      await active.media.create();
      const gB = await active.media.native.initExchange(this.target, { g: config.g, p: config.p, random: config.random }, offered.gAHash);
      signal.throwIfAborted();
      const response = await this.client.invoke(new Api.phone.AcceptCall({ peer: active.peer, gB, protocol: this.protocol() }));
      await this.handleCall(response.phoneCall);
      return ref;
    } catch { this.fail(); throw new Error('Incoming Telegram acceptance is uncertain'); }
  }

  async reject(ref: string): Promise<void> {
    const offered = this.incoming.get(ref);
    if (!offered) throw new Error('Unknown incoming call');
    await this.client.invoke(new Api.phone.DiscardCall({
      peer: new Api.InputPhoneCall({ id: offered.id, accessHash: offered.accessHash }),
      duration: 0, reason: new Api.PhoneCallDiscardReasonBusy(), connectionId: bigInt.zero,
    }));
    this.incoming.delete(ref);
  }

  private protocol(): Api.PhoneCallProtocol { return new Api.PhoneCallProtocol(NTgCalls.getProtocol()); }

  private async handleCall(call: Api.TypePhoneCall): Promise<void> {
    if (call instanceof Api.PhoneCallRequested) {
      if (this.active?.peer?.id.toString() === call.id.toString() || this.incoming.size >= 16 || this.incoming.has(call.id.toString())) return;
      this.incoming.set(call.id.toString(), call);
      this.callbacks.onIncoming(call.id.toString(), !call.video && call.adminId.toString() === this.target.toString() && call.participantId.toString() === this.account.toString());
      return; // Host must durably admit before calling accept().
    }
    if (call instanceof Api.PhoneCallDiscarded && this.incoming.delete(call.id.toString())) this.callbacks.onState(call.id.toString(), 'ended');
    const active = this.active;
    if (!active) return;
    // A previous call to the same user must not bind the new reservation.
    if (!active.peer) {
      if (active.queuedCalls.length >= 32) { this.fail(); return; }
      active.queuedCalls.push(call);
      return;
    }
    if (!active.peer || active.peer.id.toString() !== call.id.toString()) return;
    if (call instanceof Api.PhoneCallDiscarded) {
      active.abort?.(); active.signal?.close();
      try { await active.media.close(); } catch { this.fail(); return; }
      this.active = undefined;
      this.callbacks.onState(call.id.toString(), 'ended');
      return;
    }
    if (active.ending || active.uncertain) return;
    if (call instanceof Api.PhoneCallWaiting && call.receiveDate) this.callbacks.onState(call.id.toString(), 'ringing');
    if (call instanceof Api.PhoneCallAccepted && !active.confirmed) {
      active.confirmed = true;
      const keys = await active.media.native.exchangeKeys(this.target, call.gB, 0n);
      const response = await this.client.invoke(new Api.phone.ConfirmCall({ peer: active.peer, gA: keys.gAOrB,
        keyFingerprint: bigInt(keys.keyFingerprint.toString()), protocol: this.protocol() }));
      await this.handleCall(response.phoneCall);
    }
    if (call instanceof Api.PhoneCall && !active.connected) {
      active.connected = true;
      if (active.incoming) await active.media.native.exchangeKeys(this.target, call.gAOrB, BigInt(call.keyFingerprint.toString()));
      this.callbacks.onState(call.id.toString(), 'connected');
      active.signal = new TelegramSignaling({ native: active.media.native, transport: telegramSignalTransport(this.client),
        userId: this.target, callId: BigInt(call.id.toString()), accessHash: BigInt(call.accessHash.toString()), onFailure: () => this.fail() });
      try { await active.media.connect(call); }
      catch { this.fail('telegram_media_connect_failed'); throw new Error('Telegram media connection failed'); }
      for (const data of active.queuedSignals) await active.signal.receive(BigInt(call.id.toString()), data);
      active.queuedSignals = [];
    }
  }

  async end(ref: string): Promise<void> {
    const active = this.active;
    if (!active?.peer || active.peer.id.toString() !== ref) throw new Error('Unknown Telegram call reference');
    if (active.ending) return;
    active.ending = true; active.signal?.close();
    this.callbacks.onState(ref, 'ending');
    await this.discard(active);
    if (this.active === active) this.fail(); // No terminal evidence: keep the reservation.
  }

  private discard(active: ActiveCall): Promise<void> {
    if (!active.peer) return Promise.resolve();
    active.discard ??= (async () => {
      // A native cleanup failure must not prevent the platform hangup attempt.
      try { await active.media.close(); } catch { /* terminal handler retains uncertainty */ }
      try {
        const updates = await this.client.invoke(new Api.phone.DiscardCall({ peer: active.peer!, duration: 0,
          reason: new Api.PhoneCallDiscardReasonHangup(), connectionId: bigInt.zero }));
        if (updates instanceof Api.Updates || updates instanceof Api.UpdatesCombined) {
          for (const update of updates.updates) if (update instanceof Api.UpdatePhoneCall) await this.handleCall(update.phoneCall);
        }
      } catch { this.fail(); }
    })();
    return active.discard;
  }

  async writeAudio(ref: string, pcm: Buffer): Promise<void> {
    const active = this.active;
    if (!active?.peer || active.peer.id.toString() !== ref || active.ending || active.uncertain) throw new Error('Telegram call is not writable');
    await active.media.write(pcm);
  }

  async close(): Promise<void> {
    try {
      if (this.active?.peer) await this.end(this.active.peer.id.toString());
      else if (this.active) this.fail();
    } finally { for (const remove of this.removeHandlers) remove(); }
  }

  private fail(reason?: TelegramFailureReason): void {
    const active = this.active;
    if (!active || active.uncertain) return;
    active.uncertain = true; active.signal?.close(); active.abort?.();
    void active.media.close().catch(() => {});
    this.callbacks.onState(active.peer?.id.toString(), 'uncertain', reason);
    if (active.peer) void this.discard(active);
  }
}
