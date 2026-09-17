import { DomainError } from '@voxdock/core';
import { WhatsAppConnection, type WhatsAppConnectionConfig } from './connection-whatsapp.js';
import type { RuntimeManager } from './runtime-manager.js';

export async function unlinkWhatsAppAccount(manager: RuntimeManager, getConfig: () => Promise<WhatsAppConnectionConfig>, transport?: typeof fetch): Promise<{ unlinked: true }> {
  const connection = new WhatsAppConnection(await getConfig(), transport);
  const snapshot = manager.configuration.view();
  const settings = snapshot.settings;
  settings.whatsapp.enabled = false;
  for (const target of settings.targets) if (target.channel === 'whatsapp') target.enabled = false;
  // Persist disabled bindings before logout; a crash must not reactivate the old recipient.
  await manager.apply({ expected_revision: snapshot.revision, settings }, async () => {
    try { await connection.request('unlink'); }
    catch { throw new DomainError('whatsapp_unlink_unconfirmed', 503); }
  });
  return { unlinked: true };
}
