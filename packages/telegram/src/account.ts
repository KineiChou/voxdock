import { readFile, writeFile } from 'node:fs/promises';
import { linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TelegramClient, Api } from 'teleproto';
import { LogLevel } from 'teleproto/extensions/Logger.js';
import { StringSession } from 'teleproto/sessions/index.js';

export class TelegramCleanupError extends Error { constructor() { super('Telegram disconnect could not be confirmed'); } }

export interface TelegramAccountConfig {
  apiId: number;
  apiHash: string;
  sessionFile: string;
}

function createClient(config: TelegramAccountConfig, session: string): TelegramClient {
  if (!Number.isSafeInteger(config.apiId) || config.apiId <= 0 || !config.apiHash) throw new Error('Telegram application credentials required');
  const client = new TelegramClient(new StringSession(session), config.apiId, config.apiHash, {
    connectionRetries: 0, requestRetries: 0, autoReconnect: false,
  });
  client.setLogLevel(LogLevel.NONE);
  return client;
}

/** Publish a complete owner-only file exclusively, with no asynchronous gap after the abort check. */
async function persistSession(config: TelegramAccountConfig, session: string, signal?: AbortSignal): Promise<void> {
  const temporary = `${config.sessionFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, session, { mode: 0o600, flag: 'wx' });
    signal?.throwIfAborted();
    linkSync(temporary, config.sessionFile);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TelegramCleanupError();
    }
  }
}

const disconnectTimeoutMs = 5_000;

async function disconnect(client: TelegramClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.disconnect(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TelegramCleanupError()), disconnectTimeoutMs); }),
    ]);
  } catch { throw new TelegramCleanupError(); }
  finally { clearTimeout(timer); }
}

/** Interactive provisioning only. Secrets are persisted in an owner-only file, never printed. */
export async function authorizeTelegram(config: TelegramAccountConfig, prompts: {
  phoneNumber: () => Promise<string>;
  phoneCode: () => Promise<string>;
  password: () => Promise<string>;
}, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const client = createClient(config, '');
  const abort = () => { void client.disconnect().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let accountId: string;
  let session: string;
  try {
    await client.start({ ...prompts, onError: () => { throw new Error('Telegram authorization failed'); } });
    signal?.throwIfAborted();
    const account = await client.getMe();
    if (!(account instanceof Api.User) || account.bot) throw new Error('A Telegram user account is required');
    signal?.throwIfAborted();
    accountId = account.id.toString();
    session = client.session.save() as unknown as string;
  } finally { signal?.removeEventListener('abort', abort); await disconnect(client); }
  await persistSession(config, session, signal);
  return accountId;
}

/** The SDK owns token renewal, data-center migration and two-step authentication. */
export async function authorizeTelegramQr(config: TelegramAccountConfig, prompts: {
  qrCode: (challenge: { qr: string; expires_at: string }) => Promise<void>;
  password: () => Promise<string>;
}, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const client = createClient(config, '');
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let rejectAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(lifetime.signal.reason);
    lifetime.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const guard = () => lifetime.signal.throwIfAborted();
  const password = async () => {
    guard();
    const result = await Promise.race([prompts.password(), aborted]);
    guard();
    return result;
  };
  let inFlight = false;
  let lateCleanup: Promise<void> | undefined;
  let accountId: string;
  let session: string;
  const login = async () => {
    inFlight = true;
    try {
      await client.connect();
      guard();
      const account = await client.signInUserWithQrCode({ apiId: config.apiId, apiHash: config.apiHash }, {
        abortSignal: lifetime.signal,
        qrCode: async ({ token, expires }) => {
          guard();
          await Promise.race([prompts.qrCode({ qr: `tg://login?token=${token.toString('base64url')}`, expires_at: new Date(expires * 1000).toISOString() }), aborted]);
          guard();
        },
        password,
        onError: () => { guard(); throw new Error('Telegram authorization failed'); },
      });
      guard();
      if (!(account instanceof Api.User) || account.bot) throw new Error('A Telegram user account is required');
      return { accountId: account.id.toString(), session: client.session.save() as unknown as string };
    } finally {
      inFlight = false;
      // A cancelled SDK operation can settle after the caller has already left.
      if (lifetime.signal.aborted) await (lateCleanup = disconnect(client));
    }
  };
  try {
    ({ accountId, session } = await Promise.race([login(), aborted]));
  } finally {
    lifetime.abort(new Error('Telegram authorization closed'));
    signal?.removeEventListener('abort', abort);
    lifetime.signal.removeEventListener('abort', rejectAbort!);
    await disconnect(client);
    if (lateCleanup) await lateCleanup;
    // Pending SDK work can still reconnect or migrate after disconnect.
    if (inFlight) throw new TelegramCleanupError();
  }
  await persistSession(config, session, signal);
  return accountId;
}

/** Connect an already-provisioned account; ordinary service startup never starts a login flow. */
export async function connectTelegram(config: TelegramAccountConfig): Promise<TelegramClient> {
  const client = createClient(config, await readFile(config.sessionFile, 'utf8'));
  try {
    await client.connect();
    if (!await client.checkAuthorization()) throw new Error('Telegram session is not authorized');
    const account = await client.getMe();
    if (!(account instanceof Api.User) || account.bot) throw new Error('A Telegram user account is required');
    return client;
  } catch {
    await client.disconnect();
    throw new Error('Telegram account connection failed');
  }
}

export async function telegramAccountProfile(client: TelegramClient): Promise<{ userId: string; isUser: true }> {
  const user = await client.getMe();
  if (!(user instanceof Api.User) || user.bot) throw new Error('A Telegram user account is required');
  return { userId: user.id.toString(), isUser: true };
}
