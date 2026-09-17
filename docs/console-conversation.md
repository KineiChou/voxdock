# Conversation display projection

`CallStore.consoleConversation(callId)` returns `{ turns, availability }` from all retained transcript fragments in durable insertion order. It does not stop at a raw-transcript page boundary. Raw fragments and audit exports remain unchanged.

A display group contains adjacent fragments with the same session and speaker, successive sequence numbers, nondecreasing start/end timestamps, and at most a 1,500 ms gap. A source final fragment closes its group; a session/sequence restart, interleaved speaker or backward timestamp starts another. Context revisions can advance on every delta and do not split a group. Text deltas are concatenated exactly, preserving whitespace and Unicode. A group's ID is its first source fragment's ID, timestamps span its source fragments, and `fragment_count` counts those fragments. `final` is true only when the group's final source fragment is final.

These are conservative display groups, not detected utterances or exact conversational turns. Sources that never emit final fragments continue to show partial groups. Availability retains the existing available/empty/expired/disabled meanings; missing retained content is never reconstructed. Transcript retention still applies.

Tests cover a 250-fragment call spanning the raw pagination limit, exact Unicode/spacing preservation, source immutability, speaker/session/sequence boundaries, late timestamps, final markers, missing calls and retention availability.
