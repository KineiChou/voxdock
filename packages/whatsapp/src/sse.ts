/** Bounded incremental SSE decoder. EOF never dispatches an incomplete event. */
export async function* decodeSse(stream: ReadableStream<Uint8Array>, limit = 65536): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let fields: string[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        size += line.length;
        if (size > limit) throw new Error('SSE event exceeds limit');
        if (!line) {
          if (fields.length) yield fields.join('\n');
          fields = []; size = 0;
        } else if (line.startsWith('data:')) fields.push(line.slice(5).replace(/^ /, ''));
        else if (line === 'data') fields.push('');
      }
      if (pending.length + size > limit) throw new Error('SSE event exceeds limit');
      if (done) break;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
