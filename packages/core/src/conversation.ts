import type { TranscriptFragment } from '@voxdock/contracts';

type ConversationTurn = Pick<TranscriptFragment, 'id' | 'session_id' | 'speaker' | 'start_ms' | 'end_ms' | 'text' | 'final'> & { fragment_count: number };

/** Display groups of adjacent deltas, not inferred utterances or authoritative speaker turns. */
export function aggregateConversation(fragments: readonly TranscriptFragment[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let previous: TranscriptFragment | undefined;
  for (const fragment of fragments) {
    const current = turns.at(-1);
    const contiguous = previous && current && !previous.final &&
      fragment.session_id === previous.session_id && fragment.speaker === previous.speaker &&
      fragment.seq === previous.seq + 1 &&
      fragment.start_ms >= previous.start_ms && fragment.end_ms >= previous.end_ms &&
      fragment.start_ms - previous.end_ms <= 1500;
    if (contiguous) {
      // The source text is a delta. Adding whitespace or trimming would alter the transcript.
      current.text += fragment.text;
      current.end_ms = fragment.end_ms;
      current.final = fragment.final;
      current.fragment_count += 1;
    } else {
      turns.push({ id: fragment.id, session_id: fragment.session_id, speaker: fragment.speaker,
        start_ms: fragment.start_ms, end_ms: fragment.end_ms, text: fragment.text,
        final: fragment.final, fragment_count: 1 });
    }
    previous = fragment;
  }
  return turns;
}
