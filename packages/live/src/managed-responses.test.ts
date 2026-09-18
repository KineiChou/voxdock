import { describe, expect, it } from 'vitest';
import { ManagedResponses } from './managed-responses.js';
const created = (id: string) => ({ type: 'response.created', sequence_number: 0, response: { id, output: [] } });
const terminal = (id: string, type = 'response.completed') => ({ type, response: { id, output: [] } });
const delta = (itemId: string, text: string, sequence: number) => ({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: text, sequence_number: sequence });

describe('managed Responses collection', () => {
  it('collects deltas and authoritative done/items once despite empty terminal snapshots', () => {
    const parser = new ManagedResponses(); parser.receive('d1', created('r1'));
    parser.receive('d1', delta('msg1', 'Partial ', 1));
    parser.receive('d1', delta('msg1', 'Partial ', 1));
    parser.receive('d1', delta('msg1', 'answer', 2));
    parser.receive('d1', { type: 'response.output_text.done', item_id: 'msg1', output_index: 0, content_index: 0, text: 'Final answer.', sequence_number: 3 });
    parser.receive('d1', { type: 'response.output_item.done', output_index: 0, sequence_number: 4,
      item: { id: 'msg1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final answer.', annotations: [{ type: 'url_citation', url: 'https://example.com/evidence' }] }] } });
    expect(parser.receive('d1', terminal('r1'))).toEqual({ type: 'managedResponse', delegationId: 'd1', responseId: 'r1', status: 'completed', summary: 'Final answer.', evidenceUrls: ['https://example.com/evidence'] });
    expect(parser.receive('d1', terminal('r1'))).toBeUndefined();
    expect(parser.receive('d1', created('r1'))).toBeUndefined();
    expect(parser.receive('d1', terminal('r1'))).toBeUndefined();
  });
  it('keeps delegation/response identities separate and does not accept a terminal as creation', () => {
    const parser = new ManagedResponses();
    expect(parser.receive('d1', terminal('r1'))).toBeUndefined();
    parser.receive('d1', created('r1')); parser.receive('d2', created('r2'));
    parser.receive('d1', delta('msg1', 'First', 1)); parser.receive('d2', delta('msg2', 'Second', 1));
    expect(parser.receive('d1', terminal('r2'))).toBeUndefined();
    parser.receive('d2', { ...delta('msg1', 'Foreign', 99) });
    expect(parser.receive('d1', terminal('r1'))?.summary).toBe('First');
    expect(parser.receive('d2', { ...terminal('r2'), sequence_number: 2 })?.summary).toBe('Second');
  });
  it('allows a successor response without letting late prior items or duplicate terminals contaminate it', () => {
    const parser = new ManagedResponses();
    parser.receive('d', created('r1')); parser.receive('d', delta('old', 'Old', 1)); parser.receive('d', terminal('r1'));
    parser.receive('d', created('r2')); parser.receive('d', delta('new', 'New', 1));
    parser.receive('d', delta('old', 'Late', 99));
    expect(parser.receive('d', terminal('r1'))).toBeUndefined();
    expect(parser.receive('d', { ...terminal('r2'), sequence_number: 2 })?.summary).toBe('New');
  });
  it('fails closed for ambiguous overlapping responses instead of mixing untagged deltas', () => {
    const parser = new ManagedResponses(); parser.receive('d', created('r1'));
    expect(() => parser.receive('d', created('r2'))).toThrow('Overlapping');
  });
  it('bounds text and deduplicates bounded HTTP URL evidence', () => {
    const parser = new ManagedResponses(); parser.receive('d', created('r'));
    parser.receive('d', delta('msg', 'x'.repeat(5000), 1));
    for (const url of ['https://example.com/0', 'https://example.com/0', 'javascript:alert(1)', 'https://user:pass@example.com/', ...Array.from({ length: 30 }, (_, n) => `https://example.com/${n}`)]) {
      parser.receive('d', { type: 'response.output_text.annotation.added', item_id: 'msg', annotation: { type: 'url_citation', url } });
    }
    const result = parser.receive('d', terminal('r'))!;
    expect(result.summary).toHaveLength(4000);
    expect(result.evidenceUrls).toHaveLength(20);
    expect(result.evidenceUrls?.every(url => url.startsWith('https://example.com/'))).toBe(true);
  });
  it.each(['response.failed', 'response.incomplete'])('maps %s to failed without exposing raw server errors', type => {
    const parser = new ManagedResponses(); parser.receive('d', created('r'));
    const result = parser.receive('d', { ...terminal('r', type), response: { id: 'r', output: [], error: { message: 'private upstream error' } } });
    expect(result).toMatchObject({ status: 'failed', summary: 'Managed response did not complete.' });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('does not treat requested custom functions as completed work or expose arguments', () => {
    const parser = new ManagedResponses(); parser.receive('d', created('r'));
    parser.receive('d', { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fn1', call_id: 'call1', name: 'send_message', arguments: '{"secret":"private"}' } });
    const result = parser.receive('d', terminal('r'));
    expect(result).toMatchObject({ status: 'failed', summary: 'Managed response requested an unsupported function.' });
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
