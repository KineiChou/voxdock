import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TelegramSignaling } from './signaling.ts';
test('bound identities, copied signals, terminal failure and late-event isolation', async () => {
  let callback: (id: bigint, data: Buffer) => void = () => {};
  const received: bigint[] = [];
  const sent: string[] = [];
  let failed = 0;
  const bridge = new TelegramSignaling({
    native: { onSignalingData(cb) { callback = cb; }, async sendSignalingData(id) { received.push(id); } },
    transport: { async send(id, hash, data) { assert.equal(id, 22n); assert.equal(hash, 33n); sent.push(data.toString()); } },
    userId: 11n, callId: 22n, accessHash: 33n, onFailure() { failed++; },
  });
  const payload = Buffer.from('ok'); callback(11n, payload); payload.fill(0);
  callback(12n, Buffer.from('wrong'));
  await bridge.receive(23n, Buffer.from('wrong'));
  await bridge.receive(22n, Buffer.from('signal'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['ok']); assert.deepEqual(received, [11n]);
  callback(11n, Buffer.alloc(65537)); callback(11n, Buffer.from('late'));
  await bridge.receive(22n, Buffer.from('late'));
  assert.equal(failed, 1); assert.deepEqual(received, [11n]);
});
