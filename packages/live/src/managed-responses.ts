export type ManagedResponse = { type: 'managedResponse'; delegationId: string; responseId: string; status: 'completed' | 'failed'; summary: string; evidenceUrls?: string[] };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
interface Part { itemId: string; outputIndex: number; contentIndex: number; text: string; done: boolean }
interface ResponseState {
  delegationId: string;
  responseId: string;
  sequence: number;
  parts: Map<string, Part>;
  urls: Set<string>;
  characters: number;
  functionRequested: boolean;
}

/** Collect only assistant output text and URL citations, never tool arguments or reasoning. */
export class ManagedResponses {
  private readonly active = new Map<string, ResponseState>();
  private readonly owners = new Map<string, string>();
  private readonly itemOwners = new Map<string, string>();
  private readonly completed = new Set<string>();

  receive(delegationId: string, event: Record<string, unknown>): ManagedResponse | undefined {
    const response = object(event.response) ? event.response : undefined;
    if (event.type === 'response.created') {
      if (!id(response?.id) || this.completed.has(response.id)) return;
      const owner = this.owners.get(response.id);
      if (owner && owner !== delegationId) return;
      const current = this.active.get(delegationId);
      if (current) {
        if (current.responseId !== response.id) throw new Error('Overlapping managed responses');
        return;
      }
      if (this.owners.size >= 1024 || this.active.size >= 32) throw new Error('Managed response capacity exceeded');
      this.owners.set(response.id, delegationId);
      this.active.set(delegationId, { delegationId, responseId: response.id, sequence: index(event.sequence_number) ? event.sequence_number : -1,
        parts: new Map(), urls: new Set(), characters: 0, functionRequested: false });
      return;
    }
    const current = this.active.get(delegationId);
    if (!current) return;
    // Response snapshots carry their ID; deltas rely on the enclosing delegation
    // and the preceding response.created, as specified by the Live envelope.
    if (response && response.id !== current.responseId) return;
    if (event.response_id !== undefined && event.response_id !== current.responseId) return;
    const itemId = id(event.item_id) ? event.item_id : object(event.item) && id(event.item.id) ? event.item.id : undefined;
    if (itemId && this.itemOwners.has(itemId) && this.itemOwners.get(itemId) !== current.responseId) return;
    if (index(event.sequence_number)) {
      if (event.sequence_number <= current.sequence) return;
      current.sequence = event.sequence_number;
    }
    if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') {
      if (!id(event.item_id) || !index(event.output_index) || !index(event.content_index)) return;
      const value = event.type === 'response.output_text.delta' ? event.delta : event.text;
      if (typeof value === 'string') this.text(current, event.item_id, event.output_index, event.content_index, value, event.type === 'response.output_text.done');
    } else if (event.type === 'response.output_text.annotation.added') {
      if (id(event.item_id) && this.ownsItem(current, event.item_id)) this.annotation(current, event.annotation);
    } else if (event.type === 'response.output_item.done') {
      if (!object(event.item) || !id(event.item.id) || !index(event.output_index) || !this.ownsItem(current, event.item.id)) return;
      if (event.item.type === 'function_call') current.functionRequested = true;
      if (event.item.type === 'message' && event.item.role === 'assistant' && Array.isArray(event.item.content)) {
        for (const [contentIndex, part] of event.item.content.slice(0, 128).entries()) {
          if (!object(part) || part.type !== 'output_text') continue;
          if (typeof part.text === 'string') this.text(current, event.item.id, event.output_index, contentIndex, part.text, true);
          if (Array.isArray(part.annotations)) for (const annotation of part.annotations) this.annotation(current, annotation);
        }
      }
    } else if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      if (!response || response.id !== current.responseId) return;
      const status = event.type === 'response.completed' && !current.functionRequested ? 'completed' : 'failed';
      const text = [...current.parts.values()].sort((a, b) => a.outputIndex - b.outputIndex || a.contentIndex - b.contentIndex).map(part => part.text).join('\n').slice(0, 4000);
      const summary = current.functionRequested ? 'Managed response requested an unsupported function.' : text || (status === 'completed' ? 'Managed response completed without text output.' : 'Managed response did not complete.');
      this.active.delete(delegationId);
      this.completed.add(current.responseId);
      return { type: 'managedResponse', delegationId, responseId: current.responseId, status, summary,
        ...(current.urls.size ? { evidenceUrls: [...current.urls] } : {}) };
    }
    return;
  }

  private ownsItem(state: ResponseState, itemId: string): boolean {
    const owner = this.itemOwners.get(itemId);
    if (owner) return owner === state.responseId;
    if (this.itemOwners.size >= 4096) throw new Error('Managed item capacity exceeded');
    this.itemOwners.set(itemId, state.responseId);
    return true;
  }
  private text(state: ResponseState, itemId: string, outputIndex: number, contentIndex: number, value: string, done: boolean): void {
    if (!this.ownsItem(state, itemId)) return;
    const key = JSON.stringify([itemId, contentIndex]);
    const previous = state.parts.get(key);
    if (previous?.done && !done) return;
    if (!previous && state.parts.size >= 128) return;
    const existing = previous?.text ?? '';
    const available = 4000 - state.characters + existing.length;
    const text = (done ? value : existing + value).slice(0, available);
    state.characters += text.length - existing.length;
    state.parts.set(key, { itemId, outputIndex, contentIndex, text, done });
  }
  private annotation(state: ResponseState, value: unknown): void {
    if (state.urls.size >= 20 || !object(value) || value.type !== 'url_citation' || typeof value.url !== 'string' || value.url.length > 2048) return;
    try {
      const url = new URL(value.url);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) state.urls.add(url.href);
    } catch { /* A malformed citation is not evidence. */ }
  }
  clear(): void { this.active.clear(); this.owners.clear(); this.itemOwners.clear(); this.completed.clear(); }
}
