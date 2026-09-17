import { afterEach, expect, it } from 'vitest';
import type { TranscriptFragment } from '@voxdock/contracts';
import { CallStore } from './index.js';
import { aggregateConversation } from './conversation.js';
const fragment = (seq: number, patch: Partial<TranscriptFragment> = {}): TranscriptFragment => ({
  id: `f${seq}`, session_id: 's1', speaker: 'user', seq, text: 'word', start_ms: seq * 10,
  end_ms: seq * 10 + 10, final: false, context_revision: 1, ...patch,
});
it('preserves delta whitespace, Unicode and partial status without changing raw fragments', () => {
  const fragments = ['你', '好', ' world', '\n', 'cafe', '\u0301', '👩', '\u200d', '💻', '  !'].map((text, seq) => fragment(seq, { text }));
  const before = structuredClone(fragments);
  expect(aggregateConversation(fragments)).toEqual([{ id: 'f0', session_id: 's1', speaker: 'user', start_ms: 0, end_ms: 100,
    text: '你好 world\ncafé👩‍💻  !', final: false, fragment_count: 10 }]);
  expect(fragments).toEqual(before);
});
it('splits final boundaries, gaps, session/speaker switches, backwards timestamps and sequence/context restarts', () => {
  const cases: Partial<TranscriptFragment>[] = [
    { session_id: 's2' }, { speaker: 'assistant' }, { seq: 0 }, { seq: 4 },
    { start_ms: 2000, end_ms: 2010 }, { start_ms: 0, end_ms: 5 }, { context_revision: 2 },
  ];
  for (const patch of cases) expect(aggregateConversation([fragment(1), fragment(2, patch)])).toHaveLength(2);
  const turns = aggregateConversation([fragment(0), fragment(1, { final: true }), fragment(2)]);
  expect(turns.map(turn => [turn.fragment_count, turn.final])).toEqual([[2, true], [1, false]]);
  const interleaved = [fragment(0), fragment(1, { speaker: 'assistant' }), fragment(2)];
  expect(aggregateConversation(interleaved).map(turn => turn.text)).toEqual(['word', 'word', 'word']);
});
const stores: CallStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup(persistTranscripts = true) {
  const store = new CallStore(':memory:', { persistTranscripts, now: () => new Date('2026-09-17T00:00:00Z') });
  stores.push(store);
  const id = store.createCall('operator', 'conversation', { target_id: 'owner', correlation_ref: 'task:1', context_ref: 'context:1', expires_at: '2026-09-17T00:01:00Z' }, { enabled: true, allowedTargets: new Set(['owner']), maxTtlSeconds: 300 }).call.call_id;
  return { store, id };
}
it('aggregates beyond raw pagination while preserving raw audit exports and insertion order', () => {
  const { store, id } = setup();
  for (let seq = 0; seq < 250; seq++) store.appendTranscript(id, fragment(seq, { text: seq === 249 ? '.' : 'a ' }));
  expect(store.consoleTranscripts(id).fragments.length).toBeLessThan(250);
  const result = store.consoleConversation(id);
  expect(result.availability).toBe('available');
  expect(result.turns).toHaveLength(1);
  expect(result.turns[0]).toMatchObject({ fragment_count: 250, text: 'a '.repeat(249) + '.', final: false });
  expect(store.getRecord(id).transcripts).toHaveLength(250);
  store.appendTranscript(id, fragment(0, { id: 'late', session_id: 'restart', text: 'late' }));
  expect(store.consoleConversation(id).turns.map(turn => turn.id)).toEqual(['f0', 'late']);
});
it('reports empty, disabled and expired availability without inventing retained text', () => {
  const { store, id } = setup();
  expect(store.consoleConversation(id)).toEqual({ turns: [], availability: 'empty' });
  store.appendTranscript(id, fragment(0));
  store.prune({ metadataBefore: '2026-01-01T00:00:00Z', transcriptsBefore: '2027-01-01T00:00:00Z' });
  expect(store.consoleConversation(id)).toEqual({ turns: [], availability: 'expired' });
  const disabled = setup(false);
  disabled.store.appendTranscript(disabled.id, fragment(0));
  expect(disabled.store.consoleConversation(disabled.id)).toEqual({ turns: [], availability: 'disabled' });
  expect(() => store.consoleConversation('missing')).toThrow('call_not_found');
});
