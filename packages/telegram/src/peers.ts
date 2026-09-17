import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Api, type TelegramClient } from 'teleproto';
import bigInt from 'big-integer';
import { telegramUserId } from './identity.ts';
import { TelegramCleanupError } from './errors.ts';

interface Peers { account_id: string; peers: Array<{ user_id: string; access_hash: string }> }
function readPeers(sessionFile: string, accountId: string): Peers {
  let text: string;
  try { text = readFileSync(`${sessionFile}.peers.json`, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { account_id: accountId, peers: [] }; throw error; }
  if (text.length > 32_768) throw new Error('Invalid Telegram peer store');
  const data = JSON.parse(text) as Peers;
  if (data.account_id !== accountId || !Array.isArray(data.peers) || data.peers.length > 32) throw new Error('Telegram peer store account mismatch or capacity exceeded');
  const seen = new Set<string>();
  for (const peer of data.peers) {
    telegramUserId(peer.user_id);
    if (peer.user_id === accountId || seen.has(peer.user_id) || !/^-?[0-9]+$/.test(peer.access_hash) || BigInt(peer.access_hash) < -(1n << 63n) || BigInt(peer.access_hash) >= (1n << 63n)) throw new Error('Invalid Telegram peer store');
    seen.add(peer.user_id);
  }
  return data;
}

/** StringSession does not serialize entity access hashes; keep only confirmed peers separately. */
export function hydrateTelegramPeers(client: TelegramClient, sessionFile: string, accountId: string): void {
  const data = readPeers(sessionFile, accountId);
  const users = data.peers.map(peer => new Api.User({ id: bigInt(peer.user_id), accessHash: bigInt(peer.access_hash) }));
  client.session.processEntities(users);
  // SDK 1.229.0's session lookup compares string row IDs to BigInteger IDs.
  // Hydrate the public cache too, which is the first numeric lookup path.
  client.entityCache.add(users);
  for (const peer of data.peers) client.entityCache.pin(peer.user_id);
}

export function persistTelegramPeer(sessionFile: string, accountId: string, user: Api.User, guard: () => void): void {
  if (!user.accessHash || user.bot || user.min || user.deleted || user.id.toString() === accountId) throw new Error('Telegram peer cannot be bound');
  const data = readPeers(sessionFile, accountId);
  const peer = { user_id: user.id.toString(), access_hash: user.accessHash.toString() };
  telegramUserId(peer.user_id);
  const index = data.peers.findIndex(item => item.user_id === peer.user_id);
  if (index >= 0) data.peers[index] = peer;
  else { if (data.peers.length >= 32) throw new Error('Telegram confirmed peer capacity reached'); data.peers.push(peer); }
  const temporary = `${sessionFile}.${randomUUID()}.peers.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    guard();
    // This synchronous commit cannot interleave with abort or another local confirmation.
    renameSync(temporary, `${sessionFile}.peers.json`);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TelegramCleanupError(); }
  }
}
