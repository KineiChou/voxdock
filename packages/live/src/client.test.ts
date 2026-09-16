import { describe, it, expect, vi } from 'vitest';
import { LiveClient, type LiveTransport, type LiveEvent } from './client.js';

function setup(config = {}) {
  let handlers: Parameters<LiveTransport['subscribe']>[0];
  const sent: Record<string, unknown>[] = [];
  const events: LiveEvent[] = [];
  const transport = { bufferedAmount: 0, send: (s: string) => { sent.push(JSON.parse(s)); }, terminate: vi.fn(), subscribe: (h: typeof handlers) => { handlers = h; return vi.fn(); } };
  const client = new LiveClient(transport, { instructions: 'Delegate work.', ...config }, e => events.push(e));
  client.start();
  const receive = (e: object) => handlers.message(JSON.stringify(e));
  const ready = () => { handlers.open(); receive({ type: 'session.started', session: { id: 's1' } }); };
  return { client, transport, sent, events, ready, receive, handlers: () => handlers };
}

describe('Live primary protocol', () => {
  it('gates audio, uses Live startup, delegates metadata, and accepts commentary without playback claims', () => {
    const s = setup();
    expect(() => s.client.appendAudio(Buffer.alloc(960))).toThrow('not ready');
    s.ready();
    expect(s.sent[0]).toMatchObject({ type: 'session.start', session: { model: 'gpt-live-1', store: false, delegation: { type: 'client' } } });
    s.client.appendAudio(Buffer.alloc(960));
    expect(s.sent[1]?.type).toBe('session.input_audio.append');
    s.receive({ type: 'session.delegation.created', delegation: { id: 'opaque', target: 'client' }, offset_ms: 100 });
    const id = s.client.commentary('Done.', 'opaque');
    expect(s.sent[2]).toEqual({ type: 'session.commentary.append', event_id: id, delegation_id: 'opaque', content: 'Done.' });
    s.receive({ type: 'session.commentary.appended', client_event_id: id });
    expect(s.events.at(-1)).toEqual({ type: 'commentaryAccepted', clientEventId: id });
    s.client.close();
    s.receive({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 1.5 } });
    expect(s.events.at(-1)).toEqual({ type: 'closed', finalization: 'complete', reason: 'close_requested', seconds: 1.5 });
    expect(s.transport.terminate).toHaveBeenCalledTimes(1);
  });
  it('preserves transcript timing and output samples without invented turns or audio timestamps', () => {
    const s = setup(); s.ready();
    s.receive({ type: 'session.input_transcript.delta', delta: 'hello', start_ms: 0, end_ms: 50 });
    s.receive({ type: 'session.output_audio.delta', delta: Buffer.alloc(960).toString('base64') });
    expect(s.events[1]).toMatchObject({ type: 'transcript', speaker: 'user', startMs: 0, endMs: 50 });
    expect(s.events[2]).toEqual({ type: 'audio', pcm: Buffer.alloc(960) });
    s.client.close(); s.handlers().close();
    expect(s.events.at(-1)).toMatchObject({ finalization: 'incomplete' });
  });
  it('closes finitely, suppresses late audio/delegations but retains final transcripts', () => {
    vi.useFakeTimers();
    const s = setup({ closeTimeoutMs: 20 }); s.ready(); s.client.close();
    s.receive({ type: 'session.output_audio.delta', delta: 'AAA=' });
    s.receive({ type: 'session.delegation.created', delegation: { id: 'd', target: 'client' }, offset_ms: 0 });
    s.receive({ type: 'session.output_transcript.delta', delta: 'bye', start_ms: 0, end_ms: 1 });
    vi.advanceTimersByTime(20);
    s.handlers().close();
    expect(s.events.map(e => e.type)).toEqual(['ready', 'transcript', 'closed']);
    expect(s.events.at(-1)).toMatchObject({ finalization: 'incomplete', reason: 'close_timeout' });
    vi.useRealTimers();
  });
  it('rejects malformed frames and bounded transport overload', () => {
    const s = setup(); s.ready(); s.handlers().message('{bad');
    expect(s.events.at(-1)).toMatchObject({ reason: 'malformed_event' });
    const t = setup(); t.ready(); t.transport.bufferedAmount = 128000;
    expect(() => t.client.appendAudio(Buffer.alloc(960))).toThrow('backpressure');
    expect(t.events.at(-1)).toMatchObject({ reason: 'backpressure' });
  });
  it('bounds startup and reports incomplete usage even without socket close', () => {
    vi.useFakeTimers(); const s = setup({ startTimeoutMs: 10 });
    vi.advanceTimersByTime(10);
    expect(s.events.at(-1)).toMatchObject({ finalization: 'incomplete', reason: 'start_timeout' });
    vi.useRealTimers();
  });
});

it('keeps command rejection separate from finalization and bounds multilingual appends', () => {
  const s = setup(); s.ready();
  const id = s.client.instructions('Introduce yourself and greet the caller.');
  expect(s.sent.at(-1)).toMatchObject({ type: 'session.instructions.append', delegation_id: null, event_id: id });
  const context = s.client.thinking('Verified background context.');
  expect(s.sent.at(-1)).toMatchObject({ type: 'session.thinking.append', delegation_id: null, event_id: context });
  s.receive({ type: 'session.thinking.appended', client_event_id: context });
  expect(s.events.at(-1)).toEqual({ type: 'thinkingAccepted', clientEventId: context });
  expect(() => s.client.commentary('界'.repeat(167))).toThrow('500 UTF-8 bytes');
  s.receive({ type: 'error', error: { code: 'invalid_request', client_event_id: id, message: 'private text' } });
  expect(s.events.at(-1)).toEqual({ type: 'fault', code: 'invalid_request', clientEventId: id });
  expect(s.transport.terminate).not.toHaveBeenCalled();
  s.client.close();
  s.receive({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 2 } });
  expect(s.events.at(-1)).toMatchObject({ finalization: 'complete', seconds: 2 });
});
