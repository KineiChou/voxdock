import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConsoleAccount, ConsoleAccountUpdate, ConsoleAccountUpdateResult } from '@voxdock/contracts';
import { hashConsolePassword, isConsolePasswordHash, verifyConsolePassword } from './console-password.js';

interface StoredAccount extends ConsoleAccount { password_hash: string; credential_revision: number }
export class ConsoleAccountError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number) { super(code); }
}
const validUsername = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value);
const projection = (value: StoredAccount): ConsoleAccount => ({ username: value.username, revision: value.revision, allow_remote_management: value.allow_remote_management });
export interface ConsoleAccountStore {
  read(): ConsoleAccount;
  credentialRevision(): number;
  authenticate(username: string, password: string): Promise<boolean>;
  update(input: ConsoleAccountUpdate): Promise<ConsoleAccountUpdateResult>;
  /** Offline recovery requires exclusive ownership: stop the service before opening the store. */
  recover(input: { username?: string; new_password?: string; allow_remote_management?: boolean }): Promise<ConsoleAccount>;
}
export async function openConsoleAccount(options: { dataDirectory: string; legacyPasswordHash?: string }): Promise<ConsoleAccountStore> {
  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(options.dataDirectory, 'console-account.json');
  const bootstrapPath = join(options.dataDirectory, 'bootstrap-credentials.txt');
  let state: StoredAccount;
  try { state = JSON.parse(await readFile(path, 'utf8')) as StoredAccount; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const password = randomBytes(24).toString('base64url');
    if (options.legacyPasswordHash && !isConsolePasswordHash(options.legacyPasswordHash)) throw new Error('invalid_console_password_hash');
    state = { username: 'admin', revision: 1, credential_revision: 1, allow_remote_management: true,
      password_hash: options.legacyPasswordHash ?? await hashConsolePassword(password) };
    // Write credentials first so a crash cannot leave an unknown generated password.
    if (!options.legacyPasswordHash) await writeFile(bootstrapPath, `Username: admin\nPassword: ${password}\n`, { mode: 0o600, flag: 'w' });
    await writeFile(path, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  }
  if (!validUsername(state.username) || !isConsolePasswordHash(state.password_hash) || !Number.isSafeInteger(state.revision) || state.revision < 1 || !Number.isSafeInteger(state.credential_revision) || state.credential_revision < 1 || typeof state.allow_remote_management !== 'boolean') throw new Error('invalid_console_account');
  let pending = false;
  const change = async (input: { username: string; new_password?: string; allow_remote_management: boolean }): Promise<ConsoleAccountUpdateResult> => {
    if (!validUsername(input.username) || typeof input.allow_remote_management !== 'boolean') throw new ConsoleAccountError('invalid_account', 400);
    if (input.new_password !== undefined && (typeof input.new_password !== 'string' || input.new_password.length < 12 || input.new_password.length > 256)) throw new ConsoleAccountError('invalid_console_password_length', 400);
    const rotation = input.username !== state.username || input.new_password !== undefined;
    const next: StoredAccount = { ...state, username: input.username, allow_remote_management: input.allow_remote_management,
      revision: state.revision + 1, credential_revision: state.credential_revision + Number(rotation),
      password_hash: input.new_password !== undefined ? await hashConsolePassword(input.new_password) : state.password_hash };
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    state = next;
    if (rotation) await unlink(bootstrapPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return { account: projection(state), login_required: rotation };
  };
  return {
    read: () => projection(state), credentialRevision: () => state.credential_revision,
    authenticate: async (username, password) => {
      const snapshot = state;
      const valid = await verifyConsolePassword(password, snapshot.password_hash);
      return valid && username === snapshot.username && snapshot.credential_revision === state.credential_revision;
    },
    update: async input => {
      if (pending) throw new ConsoleAccountError('account_busy', 409);
      pending = true;
      try {
        if (input.revision !== state.revision) throw new ConsoleAccountError('account_revision_conflict', 409);
        if (!await verifyConsolePassword(input.current_password, state.password_hash)) throw new ConsoleAccountError('invalid_current_password', 401);
        return await change(input);
      } finally { pending = false; }
    },
    recover: async input => {
      if (pending) throw new ConsoleAccountError('account_busy', 409);
      pending = true;
      try { return (await change({ username: input.username ?? state.username, allow_remote_management: input.allow_remote_management ?? state.allow_remote_management, ...(input.new_password !== undefined ? { new_password: input.new_password } : {}) })).account; }
      finally { pending = false; }
    },
  };
}
