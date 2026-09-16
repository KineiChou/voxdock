import { setImmediate as nextTick } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { parseConfig } from '@voxdock/config';
import { CallStore } from '@voxdock/core';
import { createBridgeServer } from './server.js';

const now = new Date('2026-09-16T12:00:00Z');
const token = 'control-test-token-with-at-least-32-characters';
const config = () => parseConfig({
  security: { control_token_file: 'unused-test-reference' },
  calling: { enabled: true },
  channels: { telegram: { enabled: true, account_ref: 'tg', api_id_env: 'TEST_ID', api_hash_file: 'unused-test-reference', session_file: 'unused-test-reference' } },
  targets: [{ id: 'owner', channel: 'telegram', account_ref: 'tg', principal_ref: 'owner', peer_id_env: 'TEST_OWNER' }],
  live: { api_key_file: 'unused-test-reference' },
  backend: { id: 'test', base_url: 'http://127.0.0.1:8090', request_token_file: 'unused-test-reference', event_signing_key_file: 'unused-test-reference' },
});
const request = { target_id: 'owner', correlation_ref: 'task:1', context_ref: 'context:1', expires_at: '2026-09-16T12:01:00Z' };
const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'first' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); });
async function setup(failing = false) {
  const store = new CallStore(':memory:', { now: () => now });
  let starts = 0;
  const app = await createBridgeServer({ config: config(), store, controlToken: token, mode: 'simulation', readyChannels: new Set(['telegram']), onCallCreated: async call => {
    starts++;
    store.transition(call.call_id, 'dialing');
    if (failing) throw new Error('private provider detail');
    store.transition(call.call_id, 'connected', { audio_ready: true, live_ready: true });
  }, onEnd: async call => { store.transition(call.call_id, 'ended'); } });
  cleanup.push(async () => { await app.close(); store.close(); });
  return { app, store, starts: () => starts };
}
it('authenticates all control surfaces and rejects unexpected call fields', async () => {
  const { app } = await setup();
  expect((await app.inject('/healthz')).statusCode).toBe(200);
  expect((await app.inject('/v1/targets')).statusCode).toBe(401);
  expect((await app.inject('/v1/openapi.json')).statusCode).toBe(401);
  const invalid = await app.inject({ method: 'POST', url: '/v1/calls', headers, payload: { ...request, phone: '+12345678' } });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toEqual({ error: 'invalid_request' });
});
it('dispatches once, persists pause, and still resolves an earlier idempotency key', async () => {
  const { app, starts } = await setup();
  const first = await app.inject({ method: 'POST', url: '/v1/calls', headers, payload: request });
  expect(first.statusCode).toBe(202);
  await nextTick();
  await app.inject({ method: 'POST', url: '/v1/control/pause', headers });
  const duplicate = await app.inject({ method: 'POST', url: '/v1/calls', headers, payload: request });
  expect(duplicate.statusCode).toBe(202);
  expect(duplicate.json().call_id).toBe(first.json().call_id);
  expect(starts()).toBe(1);
  const disabled = await app.inject({ method: 'POST', url: '/v1/calls', headers: { ...headers, 'idempotency-key': 'next' }, payload: request });
  expect(disabled.statusCode).toBe(503);
});
it('keeps a failed external dispatch uncertain and sanitizes its response', async () => {
  const { app, store } = await setup(true);
  const response = await app.inject({ method: 'POST', url: '/v1/calls', headers, payload: request });
  await nextTick();
  expect(store.getCall(response.json().call_id).state).toBe('uncertain');
  const capacity = await app.inject({ method: 'POST', url: '/v1/calls', headers: { ...headers, 'idempotency-key': 'next' }, payload: request });
  expect(capacity.statusCode).toBe(409);
  expect(capacity.body).not.toContain('private');
});
it('correlates result paths and marks late-context results as not played', async () => {
  const { app, store } = await setup();
  const response = await app.inject({ method: 'POST', url: '/v1/calls', headers, payload: request });
  await nextTick();
  const callId = response.json().call_id;
  store.recordDelegation({ delegation_id: 'd1', call_id: callId, principal_ref: 'owner', context_revision: 2, occurred_at: now.toISOString(), fragments: [], completeness: 'partial' });
  const result = { result_id: 'r1', call_id: callId, delegation_id: 'd1', context_revision: 1, revision: 1, status: 'completed', spoken_summary: 'Old context.' };
  const accepted = await app.inject({ method: 'POST', url: `/v1/calls/${callId}/delegations/d1/results`, headers, payload: result });
  expect(accepted.json().playback_status).toBe('not_played');
  const wrong = await app.inject({ method: 'POST', url: `/v1/calls/${callId}/delegations/other/results`, headers, payload: result });
  expect(wrong.statusCode).toBe(409);
});
it('exports actual control schemas and validates event cursors', async () => {
  const { app } = await setup();
  const schema = (await app.inject({ url: '/v1/openapi.json', headers })).json();
  expect(schema.paths['/v1/calls'].post.requestBody).toBeDefined();
  expect((await app.inject({ url: '/v1/events?after=-1', headers })).statusCode).toBe(400);
});
