import { test } from 'vitest';
import assert from 'node:assert/strict';
import { bindTelegramTarget, telegramUserId } from './identity.ts';
test('stable positive int64 identity and separate accounts', () => {
  assert.equal(bindTelegramTarget('123', '456'), 456n);
  for (const id of ['@username', '-100123', '01', '0', '9223372036854775808']) assert.throws(() => telegramUserId(id));
  assert.throws(() => bindTelegramTarget('123', '123'));
});
