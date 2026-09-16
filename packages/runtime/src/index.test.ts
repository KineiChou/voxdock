import { test, expect, vi } from 'vitest';
import { CallStore } from '@voxdock/core';
import { parseConfig } from '@voxdock/config';
import type { DelegationResult, Delegation, BackendContext } from '@voxdock/contracts';
import type { LiveEvent } from '@voxdock/live';
import { PassThrough } from 'node:stream';
import { createRuntime, type VoiceEvents } from './index.js';

const config = () => parseConfig({
  calling: { enabled: true, ring_timeout_seconds: 1, max_call_seconds: 2 },
  security: { control_token_file: 'control.key' },
  channels: { telegram: { enabled: true, account_ref: 'owner', api_id_env: 'TG_APP', api_hash_file: 'app.key', session_file: 'session' } },
  targets: [{ id: 'self', channel: 'telegram', account_ref: 'owner', peer_id_env: 'TG_PEER', principal_ref: 'owner', enabled: true }],
  live: { api_key_file: 'live.key' },
  backend: { id: 'business', base_url: 'https://backend.invalid', request_token_file: 'backend.key', event_signing_key_file: 'signing.key' },
});
const facts: BackendContext = { context_revision: 50, obsolete: false, purpose: 'Review completed work', facts: ['Tests passed'], language: 'en' };
function request(store: CallStore) { return store.createCall('client', 'one', { target_id: 'self', correlation_ref: 'task:one', context_ref: 'task:one', expires_at: new Date(Date.now() + 200000).toISOString() }, { enabled: true, allowedTargets: new Set(['self']), maxTtlSeconds: 300 }).call; }
async function fixture(options: { connect?: boolean; obsolete?: boolean } = {}) {
  const store = new CallStore(':memory:');
  let callbacks!: VoiceEvents;
  let emit!: (event: LiveEvent) => void;
  const output: Array<{ kind: string; text: string; delegationId?: string | null }> = [];
  const audio: Uint8Array[] = [];
  let liveStarts = 0;
  const context = vi.fn(async () => ({ ...facts, obsolete: options.obsolete ?? false }));
  const delegate = vi.fn(async (input: Delegation): Promise<DelegationResult> => ({ result_id: `result-${input.context_revision}`, call_id: input.call_id, delegation_id: input.delegation_id, context_revision: input.context_revision, revision: input.context_revision, status: 'accepted', spoken_summary: 'The backend accepted the request.' }));
  const end = vi.fn(async (ref: string) => { callbacks.state(ref, 'ended'); });
  const accept = vi.fn(async (ref: string) => { callbacks.state(ref, 'connected'); callbacks.audioReady(ref); return ref; });
  const reject = vi.fn(async () => {});
  const dial = vi.fn(async () => { if (options.connect !== false) { callbacks.state('provider', 'connected'); callbacks.audioReady('provider'); } return 'provider'; });
  const runtime = await createRuntime({ config: config(), store }, {
    backend: { context, delegate }, environment: () => '123', resampler: () => new PassThrough(),
    voice: async (_target, _peer, events) => { callbacks = events; return { rate: 48000, frameMs: 10, dial, accept, reject, end, writeAudio: async () => {}, close: async () => {} }; },
    live: (_settings, listener) => { emit = listener; return {
      start() { liveStarts++; emit({ type: 'ready', sessionId: 'session' }); },
      appendAudio(pcm) { audio.push(pcm); },
      commentary(text, delegationId) { output.push({ kind: 'commentary', text, ...(delegationId === undefined ? {} : { delegationId }) }); return 'append'; },
      instructions(text) { output.push({ kind: 'instructions', text }); return 'greet'; },
      close() { emit({ type: 'closed', finalization: 'complete', reason: 'closed', seconds: 1 }); },
    }; },
  });
  const flush = () => new Promise(resolve => setTimeout(resolve, 20));
  return { store, runtime, callbacks, get emit() { return emit; }, output, audio, context, delegate, end, accept, reject, dial, flush, liveStarts: () => liveStarts,
    async close() { await runtime.close(); store.close(); } };
}
test('coordinator dials after context, greets once, delegates with transcript revision, speaks matching result and settles', async () => {
  const f = await fixture();
  try {
    const call = request(f.store);
    await f.runtime.onCallCreated(call); await f.flush();
    expect(f.context).toHaveBeenCalledTimes(2);
    expect(f.store.getCall(call.call_id)).toMatchObject({ state: 'connected', audio_ready: true, live_ready: true, provider_call_ref: 'provider' });
    expect(f.output.filter(item => item.kind === 'instructions')).toHaveLength(1);
    f.callbacks.audioReady('provider'); await f.flush();
    expect(f.output.filter(item => item.kind === 'instructions')).toHaveLength(1);
    expect(f.audio.length).toBeGreaterThan(0); // Continuous Live input, even before the first voice frame.
    f.emit({ type: 'transcript', speaker: 'user', delta: 'Please continue', startMs: 0, endMs: 10, eventId: 'transcript-1' });
    f.emit({ type: 'delegation', id: 'delegate-1', target: 'client', offsetMs: 10 });
    await new Promise(resolve => setTimeout(resolve, 130));
    expect(f.delegate).toHaveBeenCalledTimes(1);
    const payload = f.delegate.mock.calls[0]![0];
    expect(payload.context_revision).toBe(2); // Transcript revision, not backend business snapshot 50.
    expect(payload.fragments).toHaveLength(1);
    expect(f.output.some(item => item.text === 'The backend accepted the request.')).toBe(true);
    await f.runtime.onEnd(f.store.getCall(call.call_id));
    expect(f.store.getCall(call.call_id).state).toBe('ended');
    expect(f.store.getRecord(call.call_id).usage).toMatchObject({ status: 'settled', seconds: 1 });
  } finally { await f.close(); }
});
test('foreign incoming calls never receive Live; approved incoming is durably admitted before accept', async () => {
  const f = await fixture();
  try {
    f.callbacks.incoming('foreign', false); await f.flush();
    expect(f.reject).toHaveBeenCalledWith('foreign'); expect(f.liveStarts()).toBe(0); expect(f.store.listCalls()).toHaveLength(0);
    f.accept.mockImplementation(async ref => {
      expect(f.store.listCalls()[0]).toMatchObject({ direction: 'inbound', state: 'ringing', context_ref: 'inbound:self' });
      f.callbacks.state(ref, 'connected'); f.callbacks.audioReady(ref); return ref;
    });
    f.callbacks.incoming('incoming', true); await f.flush();
    expect(f.accept).toHaveBeenCalledOnce(); expect(f.liveStarts()).toBe(1);
    expect(f.store.listCalls()[0]?.direction).toBe('inbound');
  } finally { await f.close(); }
});
test('obsolete preflight never dials, and worker failure retains uncertainty', async () => {
  const stale = await fixture({ obsolete: true });
  try { const call = request(stale.store); await stale.runtime.onCallCreated(call); expect(stale.dial).not.toHaveBeenCalled(); expect(stale.store.getCall(call.call_id).state).toBe('ended'); } finally { await stale.close(); }
  const f = await fixture({ connect: false });
  try {
    const call = request(f.store); await f.runtime.onCallCreated(call);
    f.end.mockRejectedValueOnce(new Error('worker gone')); f.callbacks.fault(); await f.flush();
    expect(f.runtime.readyChannels.has('telegram')).toBe(false);
    expect(f.store.getCall(call.call_id).state).toBe('uncertain'); expect(f.liveStarts()).toBe(0);
  } finally { await f.close(); }
});
