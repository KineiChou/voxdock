/** Stable user IDs only; usernames can change ownership. */
export function telegramUserId(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('Expected a positive Telegram user ID');
  const id = BigInt(value);
  if (id > 9223372036854775807n) throw new Error('Telegram user ID exceeds int64');
  return id;
}

export function bindTelegramTarget(accountId: string, targetId: string): bigint {
  const account = telegramUserId(accountId);
  const target = telegramUserId(targetId);
  if (account === target) throw new Error('Caller and target must differ');
  return target;
}
