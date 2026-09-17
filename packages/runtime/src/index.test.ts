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
function request(store: CallStore, key = 'one') { return store.createCall('client', key, { target_id: 'self', correlation_ref: `task:${key}`, context_ref: `task:${key}`, expires_at: new Date(Date.now() + 200000).toISOString() }, { enabled: true, allowedTargets: new Set(['self']), maxTtlSeconds: 300 }).call; }
async function fixture(options: { connect?: boolean; obsolete?: boolean; maxSeconds?: number; liveReady?: boolean } = {}) {
  const store = new CallStore(':memory:');
  let callbacks!: VoiceEvents;
  let emit!: (event: LiveEvent) => void;
  const output: Array<{ kind: string; text: string; delegationId?: string | null }> = [];
  const audio: Uint8Array[] = [];
  let liveStarts = 0;
  const context = vi.fn(async () => ({ ...facts, obsolete: options.obsolete ?? false }));
  const delegate = vi.fn(async (input: Delegation): Promise<DelegationResult> => ({ result_id: `result-${input.context_revision}`, call_id: input.call_id, delegation_id: input.delegation_id, context_revision: input.context_revision, revision: input.context_revision, status: 'accepted', spoken_summary: 'The backend accepted the request.' }));
  const deliverEvent = vi.fn(async () => {});
  const end = vi.fn(async (ref: string) => { callbacks.state(ref, 'ended'); });
  const accept = vi.fn(async (ref: string) => { callbacks.state(ref, 'connected'); callbacks.audioReady(ref); return ref; });
  const reject = vi.fn(async () => {});
  const dial = vi.fn(async () => { if (options.connect !== false) { callbacks.state('provider', 'connected'); callbacks.audioReady('provider'); } return 'provider'; });
  const settings = config();
  settings.calling.max_call_seconds = options.maxSeconds ?? 2;
  const instruction = vi.fn((text: string) => { output.push({ kind: 'instructions', text }); return 'append'; });
  const runtime = await createRuntime({ config: settings, store }, {
    backend: { context, delegate, deliverEvent }, environment: () => '123', resampler: () => new PassThrough(),
    voice: async (_target, _peer, events) => { callbacks = events; return { rate: 48000, frameMs: 10, dial, accept, reject, end, writeAudio: async () => {}, close: async () => {} }; },
    live: (_settings, listener) => { emit = listener; return {
      start() { liveStarts++; if (options.liveReady !== false) emit({ type: 'ready', sessionId: 'session' }); },
      appendAudio(pcm) { audio.push(pcm); },
      commentary(text, delegationId) { output.push({ kind: 'commentary', text, ...(delegationId === undefined ? {} : { delegationId }) }); return 'append'; },
      thinking(text) { output.push({ kind: 'thinking', text }); return 'context'; },
      instructions: instruction,
      close() { emit({ type: 'closed', finalization: 'complete', reason: 'closed', seconds: 1 }); },
    }; },
  });
  const flush = () => new Promise(resolve => setTimeout(resolve, 20));
  return { store, runtime, callbacks, get emit() { return emit; }, output, audio, instruction, context, delegate, deliverEvent, end, accept, reject, dial, flush, liveStarts: () => liveStarts,
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
    expect(f.output.filter(item => item.kind === 'commentary')).toHaveLength(0);
    expect(f.output.some(item => item.kind === 'thinking' && item.text.includes('Tests passed'))).toBe(true);
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
test('runtime delivers durable call events and acknowledges the outbox', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  try {
    await f.runtime.onCallCreated(request(f.store));
    await vi.advanceTimersByTimeAsync(1005);
    expect(f.deliverEvent).toHaveBeenCalled();
    expect(f.store.pendingEvents()).toHaveLength(0);
  } finally { await f.close(); vi.useRealTimers(); }
});
test('a pause during asynchronous preflight prevents the platform side effect', async () => {
  const f = await fixture();
  try {
    f.context.mockImplementationOnce(async () => { f.store.setPaused(true); return facts; });
    const call = request(f.store);
    await f.runtime.onCallCreated(call);
    expect(f.dial).not.toHaveBeenCalled();
    expect(f.store.getCall(call.call_id)).toMatchObject({ state: 'ended', reason: 'paused' });
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

test('late terminal evidence resolves a call-scoped media failure without disabling the channel', async () => {
  const f = await fixture();
  try {
    const call = request(f.store); await f.runtime.onCallCreated(call); await f.flush();
    f.end.mockRejectedValueOnce(new Error('upstream already removed the call'));
    f.callbacks.state('provider', 'uncertain'); await f.flush();
    expect(f.store.getCall(call.call_id).state).toBe('uncertain');
    expect(f.runtime.readyChannels.has('telegram')).toBe(true);
    expect(() => request(f.store, 'two')).toThrow('call_capacity');
    f.callbacks.state('provider', 'ended');
    expect(f.store.getCall(call.call_id).state).toBe('ended');
    const next = request(f.store, 'two'); await f.runtime.onCallCreated(next); await f.flush();
    expect(f.store.getCall(next.call_id).state).toBe('connected');
    expect(f.liveStarts()).toBe(2);
  } finally { await f.close(); }
});


test.each([2, 80])('warns once at the duration boundary and retains the hard deadline (%i seconds)', async maxSeconds => {
  vi.useFakeTimers();
  const f = await fixture({ maxSeconds });
  try {
    const call = request(f.store);
    await f.runtime.onCallCreated(call);
    const warningAt = (maxSeconds - Math.min(30, maxSeconds / 2)) * 1000;
    await vi.advanceTimersByTimeAsync(warningAt - 1);
    expect(f.instruction).toHaveBeenCalledTimes(1);
    // A failed warning append must remain best-effort, without retry or an unhandled throw.
    if (maxSeconds === 2) f.instruction.mockImplementationOnce(() => { throw new Error('append rejected'); });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.instruction).toHaveBeenCalledTimes(2);
    expect(f.instruction.mock.calls[1]![0]).toContain('language of the current conversation context');
    f.callbacks.state('provider', 'connected');
    await vi.advanceTimersByTimeAsync(maxSeconds * 1000 - warningAt - 1);
    expect(f.end).not.toHaveBeenCalled();
    expect(f.instruction).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.end).toHaveBeenCalledOnce();
    expect(f.store.getCall(call.call_id)).toMatchObject({ state: 'ended', reason: 'duration_limit' });
  } finally { await f.close(); vi.useRealTimers(); }
});

test.each(['ended', 'not-ready'] as const)('skips the warning when %s without starting another Live session', async mode => {
  vi.useFakeTimers();
  const f = await fixture({ liveReady: mode !== 'not-ready' });
  try {
    const call = request(f.store);
    await f.runtime.onCallCreated(call);
    await vi.advanceTimersByTimeAsync(500);
    if (mode === 'ended') await f.runtime.onEnd(f.store.getCall(call.call_id));
    const count = f.instruction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.instruction).toHaveBeenCalledTimes(count);
    expect(f.liveStarts()).toBe(1);
    expect(f.end).toHaveBeenCalledOnce();
  } finally { await f.close(); vi.useRealTimers(); }
});

test('audio overflow records its fixed boundary reason before platform cleanup', async () => {
  const f = await fixture();
  try {
    const call = request(f.store);
    await f.runtime.onCallCreated(call); await f.flush();
    f.emit({ type: 'audio', pcm: Buffer.alloc(48001) });
    await f.flush();
    expect(f.end).toHaveBeenCalledOnce();
    expect(f.store.getCall(call.call_id)).toMatchObject({ state: 'ended', reason: 'audio_output_overflow' });
  } finally { await f.close(); }
});
