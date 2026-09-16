import { test } from 'vitest';
import assert from 'node:assert/strict';
import { WaCallsControl, normalizePhone, parseCallEvent } from './control.ts';
import { decodeSse } from './sse.ts';
const options = { baseUrl: 'http://127.0.0.1:8787', sessionId: 's/1', clientId: 'voxdock', ownPhone: '+12025550100', targetPhone: '+12025550101' };
test('fixed recipient, encoded session, recording disabled; no automatic retry', async () => {
  let count = 0;
  const client = new WaCallsControl({ ...options, fetch: async (url, init) => {
    count++;
    assert.equal(String(url), 'http://127.0.0.1:8787/api/sessions/s%2F1/calls');
    assert.deepEqual(JSON.parse(String(init?.body)), { phone: '12025550101', record: false });
    assert.equal(init?.redirect, 'error');
    return Response.json({ call: { callId: 'upstream-id' } });
  } });
  assert.equal(await client.dial(AbortSignal.timeout(1000)), 'upstream-id');
  assert.equal(count, 1);
});
test('internal transport and stable targets fail closed', () => {
  for (const baseUrl of ['file:///tmp/socket', 'http://user:pass@host', 'http://127.0.0.1/api', 'http://127.0.0.1/?token=secret']) assert.throws(() => new WaCallsControl({ ...options, baseUrl }));
  assert.throws(() => new WaCallsControl({ ...options, targetPhone: options.ownPhone }));
  for (const phone of ['abc12025550101', '1202 555 0101', '01234', '']) assert.throws(() => normalizePhone(phone));
});
test('uncertain HTTP outcome invokes transport once', async () => {
  let count = 0;
  const client = new WaCallsControl({ ...options, fetch: async () => { count++; throw new Error('lost reply'); } });
  await assert.rejects(client.dial(AbortSignal.timeout(1000)), /lost reply/);
  assert.equal(count, 1);
});
test('provider events require identity and do not claim confirmed ringing', () => {
  const event = JSON.stringify({ type: 'call-status', sessionId: 's', id: 'c', status: 'ringing' });
  assert.equal(parseCallEvent(event, 's', 'c')?.state, 'dialing');
  assert.equal(parseCallEvent(event, 'other', 'c'), undefined);
  assert.throws(() => parseCallEvent('{"type":"call-ended"}', 's', 'c'));
  assert.throws(() => parseCallEvent('{"type":"call-status","sessionId":"s","id":"c","status":"surprise"}', 's', 'c'));
});
function stream(parts: string[]) { return new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } }); }
test('SSE chunking, CRLF, comments, multiline data and truncated EOF', async () => {
  const output = [];
  for await (const item of decodeSse(stream([': keepalive\r\nda', 'ta: one\r\ndata: two\r\n\r', '\ndata: truncated']))) output.push(item);
  assert.deepEqual(output, ['one\ntwo']);
});
test('SSE bounds unterminated data', async () => {
  await assert.rejects(async () => { for await (const _ of decodeSse(stream(['data: too long']), 4)) {} }, /limit/);
});
