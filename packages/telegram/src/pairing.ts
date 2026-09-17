import { Api, type TelegramClient } from 'teleproto';
import bigInt from 'big-integer';
import { connectTelegram, TelegramCleanupError, type TelegramAccountConfig } from './account.ts';
import { persistTelegramPeer } from './peers.ts';

export type TelegramPairingIdentity = { user_id: string; display_name: string; username?: string; phone?: string };
export interface TelegramPairingObserver {
  readonly account: TelegramPairingIdentity;
  candidate(): TelegramPairingIdentity | undefined;
  confirm(userId: string): Promise<void>;
  close(): Promise<void>;
}
function identity(user: Api.User): TelegramPairingIdentity {
  return { user_id: user.id.toString(), display_name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.id.toString(),
    ...(user.username ? { username: user.username } : {}), ...(user.phone ? { phone: user.phone } : {}) };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TelegramCleanupError()), 5_000); })]); }
  finally { clearTimeout(timer); }
}

/** Passive proof collection only: incoming verification calls are rejected, never answered. */
export async function observeTelegramPairing(config: TelegramAccountConfig, input: {
  method: 'message' | 'call'; code?: string; expires_at: string;
}, signal?: AbortSignal): Promise<TelegramPairingObserver> {
  const started = input.method === 'message' ? Math.floor(Date.now() / 1000) : Math.ceil(Date.now() / 1000);
  const expires = Date.parse(input.expires_at);
  if (!Number.isFinite(expires) || expires <= Date.now() || expires - Date.now() > 24 * 60 * 60 * 1000 || (input.method === 'message' && !input.code)) throw new Error('Invalid Telegram pairing challenge');
  signal?.throwIfAborted();
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => lifetime.abort(new Error('Telegram pairing expired')), expires - Date.now());
  let client: TelegramClient | undefined;
  let closed = false;
  let failure: Error | undefined;
  let selected: Api.User | undefined;
  let reserved = false;
  let pending: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const removers: Array<() => void> = [];
  const guard = () => {
    if (failure) throw failure;
    lifetime.signal.throwIfAborted();
    if (closed || Date.now() >= expires) throw new Error('Telegram pairing closed');
  };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      lifetime.signal.removeEventListener('abort', onAbort);
      for (const remove of removers) { try { remove(); } catch { failure = new TelegramCleanupError(); } }
      try {
        if (client) await bounded(client.disconnect());
        await bounded(pending);
      } catch { failure = new TelegramCleanupError(); }
      if (failure) throw failure;
    })();
    return closing;
  };
  const onAbort = () => { void close().catch(() => {}); };
  lifetime.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const connecting = connectTelegram(config);
    const cancelled = new Promise<never>((_, reject) => lifetime.signal.addEventListener('abort', () => reject(new TelegramCleanupError()), { once: true }));
    // A late successful connection must not survive an expired setup attempt.
    void connecting.then(async connected => { if (closed) await bounded(connected.disconnect()); }).catch(() => {});
    client = await Promise.race([connecting, cancelled]);
    guard();
    const account = await Promise.race([client.getMe(), cancelled]);
    guard();
    if (!(account instanceof Api.User) || account.bot || account.deleted) throw new Error('Telegram user account required');
    const accountId = account.id.toString();
    const fresh = (date: number) => date >= started && date <= Math.floor(Date.now() / 1000) && date * 1000 < expires;
    const observe = (work: () => Promise<void>) => {
      if (closed || lifetime.signal.aborted || selected || reserved) return;
      reserved = true;
      pending = (async () => { try { guard(); await work(); } catch (error) {
        if (error instanceof TelegramCleanupError) failure = error;
      } finally { reserved = false; } })();
    };
    const resolveUser = async (id: string): Promise<Api.User | undefined> => {
      const user = await client!.getEntity(bigInt(id));
      guard();
      if (!(user instanceof Api.User) || user.id.toString() !== id || user.bot || user.deleted || user.min || !user.accessHash || id === accountId) return;
      return user;
    };
    if (input.method === 'message') {
      removers.push(client.updates.on('newMessage', update => {
        const message = update.message;
        if (!(message instanceof Api.Message) || message.out || message.fwdFrom || message.viaBotId || message.message !== input.code || !fresh(message.date)
          || !(message.peerId instanceof Api.PeerUser) || (message.fromId && !(message.fromId instanceof Api.PeerUser))) return;
        const senderId = (message.fromId ?? message.peerId).userId.toString();
        if (senderId === accountId || (message.peerId.userId.toString() !== senderId && message.peerId.userId.toString() !== accountId)) return;
        observe(async () => { const user = await resolveUser(senderId); guard(); if (user) selected = user; });
      }));
    } else {
      removers.push(client.updates.on('phoneCall', update => {
        const call = update.phoneCall;
        if (!(call instanceof Api.PhoneCallRequested) || call.video || !fresh(call.date) || call.participantId.toString() !== accountId || call.adminId.toString() === accountId) return;
        observe(async () => {
          let result: Api.TypeUpdates;
          try { result = await bounded(client!.invoke(new Api.phone.DiscardCall({ peer: new Api.InputPhoneCall({ id: call.id, accessHash: call.accessHash }), duration: 0, reason: new Api.PhoneCallDiscardReasonBusy(), connectionId: bigInt.zero }))); }
          catch { throw new TelegramCleanupError(); }
          const ended = (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) && result.updates.some(item => item instanceof Api.UpdatePhoneCall && item.phoneCall instanceof Api.PhoneCallDiscarded && item.phoneCall.id.equals(call.id));
          if (!ended) throw new TelegramCleanupError();
          guard();
          const user = await resolveUser(call.adminId.toString());
          guard();
          if (user) selected = user;
        });
      }));
    }
    return {
      account: identity(account),
      candidate() { if (failure) throw failure; if (closed || lifetime.signal.aborted || Date.now() >= expires) return undefined; return selected ? identity(selected) : undefined; },
      async confirm(userId) { guard(); if (!selected || selected.id.toString() !== userId) throw new Error('Telegram pairing candidate mismatch'); persistTelegramPeer(config.sessionFile, accountId, selected, guard); },
      close,
    };
  } catch (error) { await close(); throw error; }
}
