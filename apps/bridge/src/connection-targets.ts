import { DomainError } from '@voxdock/core';
import type { RuntimeManager } from './runtime-manager.js';

/** Telegram's manual fallback keeps application identities server-owned. */
export async function saveTelegramTarget(manager: RuntimeManager, input: { peer_id: string; enabled: boolean }) {
  if (!/^[1-9][0-9]{0,18}$/.test(input.peer_id)) throw new DomainError('invalid_telegram_target', 400);
  const snapshot = manager.configuration.view();
  const settings = snapshot.settings;
  const previous = settings.targets.find(target => target.channel === 'telegram');
  settings.targets = settings.targets.filter(target => target.channel !== 'telegram');
  settings.targets.push({ id: previous?.id ?? 'telegram-self', channel: 'telegram', account_ref: settings.telegram.account_ref,
    principal_ref: previous?.principal_ref ?? 'owner', peer_id: input.peer_id, enabled: input.enabled });
  return manager.apply({ expected_revision: snapshot.revision, settings });
}
