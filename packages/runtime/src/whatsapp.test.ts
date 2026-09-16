import { expect, test, vi } from 'vitest';
import { createWhatsAppDriver, whatsAppPhone } from './whatsapp.js';
import type { VoiceEvents } from './types.js';
function fixture(overrides: { paired?: boolean; target?: string; calls?: unknown[]; acknowledged?: boolean } = {}) {
  const session = { id: 'session', jid: '12025550100:1@s.whatsapp.net', paired: overrides.paired ?? true, state: 'open' };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const send = (value: object) => { if (!ended) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)); };
  const callbacks: VoiceEvents = { state: vi.fn(), audio: vi.fn(), audioReady: vi.fn(), incoming: vi.fn(), fault: vi.fn() };
  const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/sessions') return Response.json({ sessions: [session] });
    if (path === '/api/events') return new Response(new ReadableStream<Uint8Array>({
      start(c) { controller = c; send({ type: 'session-list', sessions: [session] }); send({ type: 'call-list', calls: overrides.calls ?? [] });
        init?.signal?.addEventListener('abort', () => { if (!ended) { ended = true; c.close(); } }, { once: true }); },
      cancel() { ended = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
    if (path.endsWith('/calls') && init?.method === 'POST') return Response.json({ call: { callId: 'call' } });
    if (path.endsWith('/accept')) return Response.json({ call: { callId: 'incoming' } });
    if (init?.method === 'DELETE') { send({ type: 'call-ended', sessionId: 'session', id: 'call', reason: 'user_ended', ...(overrides.acknowledged ? { termination: 'acknowledged' } : {}) }); return overrides.acknowledged ? Response.json({ status: 'ended', termination: 'acknowledged' }) : new Response(null, { status: 204 }); }
    return Response.json({ status: 'ok' });
  });
  const writeAudio = vi.fn(); const mediaClose = vi.fn();
  const media = vi.fn(async () => ({ writeAudio, close: mediaClose }));
  const options = { baseUrl: 'http://wacalls:8080', sessionId: 'session', peerId: overrides.target ?? '12025550101@s.whatsapp.net', mediaSecret: 's'.repeat(32), fetch: fetcher as typeof fetch, media };
  return { callbacks, send, media, writeAudio, options, fetcher, flush: () => new Promise(resolve => setImmediate(resolve)) };
}
test('paired-session identity, actual connected evidence and call-bound PCM; local termination stays uncertain', async () => {
  const f = fixture(); const driver = await createWhatsAppDriver(f.options, f.callbacks);
  try {
    expect(await driver.dial(f.options.peerId, AbortSignal.timeout(1000))).toBe('call');
    expect(f.media).not.toHaveBeenCalled();
    f.send({ type: 'call-status', sessionId: 'session', id: 'call', status: 'ringing' }); await f.flush();
    expect(f.callbacks.state).not.toHaveBeenCalledWith('call', 'connected');
    f.send({ type: 'call-status', sessionId: 'session', id: 'call', status: 'connected' }); await f.flush();
    expect(f.media).toHaveBeenCalledOnce(); expect(f.callbacks.audioReady).toHaveBeenCalledWith('call');
    await driver.writeAudio('call', Buffer.alloc(640)); expect(f.writeAudio).toHaveBeenCalledOnce();
    await driver.end('call'); await f.flush();
    expect(f.callbacks.state).toHaveBeenLastCalledWith('call', 'uncertain');
    await expect(driver.dial(f.options.peerId, AbortSignal.timeout(1000))).rejects.toThrow('unavailable');
  } finally { await driver.close(); }
});
test('foreign or unresolved incoming identities cannot be accepted, allowed offer waits for explicit admission', async () => {
  const f = fixture(); const driver = await createWhatsAppDriver(f.options, f.callbacks);
  try {
    f.send({ type: 'incoming', sessionId: 'session', id: 'foreign', peer: '777@lid' }); await f.flush();
    expect(f.callbacks.incoming).toHaveBeenCalledWith('foreign', false);
    await expect(driver.accept('foreign', AbortSignal.timeout(1000))).rejects.toThrow('not admitted');
    f.send({ type: 'incoming', sessionId: 'session', id: 'incoming', peer: f.options.peerId }); await f.flush();
    expect(f.callbacks.incoming).toHaveBeenCalledWith('incoming', true);
    expect(f.media).not.toHaveBeenCalled();
    await driver.accept('incoming', AbortSignal.timeout(1000));
    expect(f.callbacks.state).not.toHaveBeenCalledWith('incoming', 'connected');
  } finally { await driver.close(); }
});
test('readiness rejects unpaired, same-account and unreconciled upstream calls', async () => {
  for (const overrides of [{ paired: false }, { target: '12025550100@s.whatsapp.net' }, { calls: [{ sessionId: 'session', callId: 'old' }] }]) {
    const f = fixture(overrides); await expect(createWhatsAppDriver(f.options, f.callbacks)).rejects.toThrow();
  }
  expect(whatsAppPhone('12025550100:4@s.whatsapp.net')).toBe('12025550100');
});

test('explicit patched termination acknowledgment releases the adapter reservation', async () => {
  const f = fixture({ acknowledged: true }); const driver = await createWhatsAppDriver(f.options, f.callbacks);
  try {
    await driver.dial(f.options.peerId, AbortSignal.timeout(1000));
    await driver.end('call'); await f.flush();
    expect(f.callbacks.state).toHaveBeenLastCalledWith('call', 'ended');
    expect(await driver.dial(f.options.peerId, AbortSignal.timeout(1000))).toBe('call');
  } finally { await driver.close(); }
});

test('an upstream stored phone mapping can authorize an LID without guessing from its digits', async () => {
  const f = fixture(); const driver = await createWhatsAppDriver(f.options, f.callbacks);
  try {
    f.send({ type: 'incoming', sessionId: 'session', id: 'mapped', peer: '777@lid', peer_phone_jid: f.options.peerId });
    await f.flush(); expect(f.callbacks.incoming).toHaveBeenCalledWith('mapped', true);
    f.send({ type: 'incoming', sessionId: 'session', id: 'unmapped', peer: '12025550101@lid' });
    await f.flush(); expect(f.callbacks.incoming).toHaveBeenCalledWith('unmapped', false);
  } finally { await driver.close(); }
});
