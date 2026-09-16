import { chmod, readFile, writeFile } from 'node:fs/promises';
import { TelegramClient, Api } from 'teleproto';
import { LogLevel } from 'teleproto/extensions/Logger.js';
import { StringSession } from 'teleproto/sessions/index.js';

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

/** Interactive provisioning only. Secrets are persisted in an owner-only file, never printed. */
export async function authorizeTelegram(config: TelegramAccountConfig, prompts: {
  phoneNumber: () => Promise<string>;
  phoneCode: () => Promise<string>;
  password: () => Promise<string>;
}): Promise<string> {
  const client = createClient(config, '');
  try {
    await client.start({ ...prompts, onError: () => { throw new Error('Telegram authorization failed'); } });
    const account = await client.getMe();
    if (!(account instanceof Api.User) || account.bot) throw new Error('A Telegram user account is required');
    await writeFile(config.sessionFile, client.session.save() as unknown as string, { mode: 0o600, flag: 'wx' });
    await chmod(config.sessionFile, 0o600);
    return account.id.toString();
  } finally { await client.disconnect(); }
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
