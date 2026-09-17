import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectionService } from './connection-service.js';
import { registerConnectionRoutes } from './connection-routes.js';

const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(transport: typeof fetch) {
  const directory = mkdtempSync(join(tmpdir(), 'voxdock-qr-test-')); directories.push(directory);
  const release = vi.fn(async (_safe: boolean) => {});
  const acquire = vi.fn(async () => release);
  const service = createConnectionService({ acquire, fetch: transport,
    getWhatsAppConfig: async () => ({ baseUrl: 'http://sidecar:8080', sessionId: 'fixed', clientId: 'voxdock' }),
    getTelegramConfig: async () => ({ apiId: 1, apiHash: 'test', sessionFile: join(directory, 'session') }),
    telegramAuthorize: async (_, prompts) => { await prompts.phoneCode(); return 'account'; },
  });
  return { service, release, acquire };
}
const qr = (value: string) => ({ paired: false, state: 'qr', qr: value, qr_expires_at: new Date(Date.now() + 60000).toISOString() });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

it('refreshes through a fixed sidecar mutation, retains its lease and ignores a late pre-refresh status', async () => {
  let completeOldStatus!: (response: Response) => void;
  let completeRefresh!: (response: Response) => void;
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(qr('old-qr')))
    .mockImplementationOnce(() => new Promise(resolve => { completeOldStatus = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { completeRefresh = resolve; }))
    .mockResolvedValueOnce(Response.json({ paired: false, state: 'disconnected' }));
  const { service, release, acquire } = fixture(transport);
  const original = await service.startWhatsApp(); await tick();
  const staleRead = service.flow(original.id);
  const refreshed = await service.refreshWhatsApp(original.id);
  expect(refreshed).toMatchObject({ id: original.id, state: 'starting' });
  expect(refreshed.qr).toBeUndefined(); expect(refreshed.qr_expires_at).toBeUndefined();
  expect(String(transport.mock.calls[2]![0])).toBe('http://sidecar:8080/api/voxdock/sessions/fixed/refresh');
  expect(transport.mock.calls[2]![1]?.body).toBe('{}');
  await expect(service.refreshWhatsApp(original.id)).rejects.toThrow('connection_operation_active');
  expect(acquire).toHaveBeenCalledTimes(1); expect(release).not.toHaveBeenCalled();
  completeRefresh(Response.json(qr('fresh-qr'))); await tick();
  completeOldStatus(Response.json(qr('old-qr')));
  expect(await staleRead).toMatchObject({ state: 'qr_required', qr: 'fresh-qr' });
  expect((await service.cancel(original.id)).state).toBe('cancelled');
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it('drains refresh before cancellation and never shows its late QR', async () => {
  let completeRefresh!: (response: Response) => void;
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(qr('old')))
    .mockImplementationOnce(() => new Promise(resolve => { completeRefresh = resolve; }))
    .mockResolvedValueOnce(Response.json({ paired: false, state: 'disconnected' }));
  const { service, release } = fixture(transport);
  const flow = await service.startWhatsApp(); await tick(); await service.refreshWhatsApp(flow.id);
  const cancelled = service.cancel(flow.id); await tick();
  expect(transport).toHaveBeenCalledTimes(2); expect(release).not.toHaveBeenCalled();
  completeRefresh(Response.json(qr('late')));
  expect(await cancelled).toMatchObject({ state: 'cancelled' });
  expect((await service.flow(flow.id)).qr).toBeUndefined();
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it('preserves an account that completes pairing while refresh is requested', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(qr('old')))
    .mockResolvedValueOnce(Response.json({ paired: true, state: 'open' }));
  const { service, release } = fixture(transport);
  const flow = await service.startWhatsApp(); await tick(); await service.refreshWhatsApp(flow.id); await tick();
  expect(await service.flow(flow.id)).toMatchObject({ state: 'connected' });
  expect(await service.refreshWhatsApp(flow.id)).toMatchObject({ state: 'connected' });
  expect(transport).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it.each([
  ['pairing_failed', 'failed', 'whatsapp_pairing_failed'],
  ['client_outdated', 'failed', 'whatsapp_client_outdated'],
  ['qr_expired', 'expired', 'whatsapp_qr_expired'],
])('clears a stale QR and confirms cleanup after %s', async (state, terminal, error) => {
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(qr('old')))
    .mockResolvedValueOnce(Response.json({ paired: false, state, qr: 'stale-must-not-appear' }))
    .mockResolvedValueOnce(Response.json({ paired: false, state: 'disconnected' }));
  const { service, release } = fixture(transport);
  const flow = await service.startWhatsApp(); await tick();
  const result = await service.flow(flow.id);
  expect(result).toMatchObject({ state: terminal, error }); expect(result.qr).toBeUndefined();
  expect(result.qr_expires_at).toBeUndefined(); expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it('clears unavailable and expired QR data and clears transient errors on recovery', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(qr('old')))
    .mockRejectedValueOnce(new Error('private provider failure'))
    .mockResolvedValueOnce(Response.json({ ...qr('expired'), qr_expires_at: new Date(Date.now() - 1000).toISOString() }))
    .mockResolvedValueOnce(Response.json(qr('fresh')))
    .mockResolvedValueOnce(Response.json({ paired: false, state: 'disconnected' }));
  const { service } = fixture(transport);
  const flow = await service.startWhatsApp(); await tick();
  const failedRead = await service.flow(flow.id);
  expect(failedRead).toMatchObject({ state: 'starting', error: 'whatsapp_status_unavailable' }); expect(failedRead.qr).toBeUndefined();
  const expiredCode = await service.flow(flow.id);
  expect(expiredCode.state).toBe('starting'); expect(expiredCode.qr).toBeUndefined(); expect(expiredCode.error).toBeUndefined();
  expect(await service.flow(flow.id)).toMatchObject({ state: 'qr_required', qr: 'fresh' });
  await service.close();
});

it('rejects stale and Telegram refresh and applies strict no-store HTTP contracts', async () => {
  const { service } = fixture(vi.fn<typeof fetch>());
  const flow = await service.startTelegram('+12345678901');
  await vi.waitFor(async () => expect((await service.flow(flow.id)).state).toBe('code_required'));
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  registerConnectionRoutes(app, '/admin/v1', service);
  const url = `/admin/v1/connections/flows/${flow.id}/refresh`;
  expect((await app.inject({ method: 'POST', url, payload: { session_id: 'arbitrary' } })).statusCode).toBe(400);
  const response = await app.inject({ method: 'POST', url, payload: {} });
  expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ error: 'connection_challenge_stale' });
  expect(response.headers['cache-control']).toBe('no-store');
  await service.cancel(flow.id); await expect(service.refreshWhatsApp(flow.id)).rejects.toThrow('connection_challenge_stale');
  await app.close(); await service.close();
});

it('keeps an uncertain refresh blocked even when its transport completes late', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(qr('old'))).mockImplementationOnce(() => new Promise(() => {}));
  const { service, release } = fixture(transport);
  const flow = await service.startWhatsApp(); await tick(); vi.useFakeTimers();
  await service.refreshWhatsApp(flow.id); await vi.advanceTimersByTimeAsync(10001);
  expect(await service.flow(flow.id)).toMatchObject({ state: 'failed', error: 'connection_cleanup_required' });
  expect(release).toHaveBeenCalledExactlyOnceWith(false); await service.close();
});
