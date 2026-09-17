import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createConnectionService } from './connection-service.js';
import { registerConnectionRoutes } from './connection-routes.js';
import { WhatsAppConnection } from './connection-whatsapp.js';
const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive:true, force:true }))); });
async function dependencies() {
 const directory = await mkdtemp(join(tmpdir(), 'voxdock-connection-')); dirs.push(directory);
 const release = vi.fn(async (_safe: boolean) => {});
 return { release, acquire: vi.fn(async () => release), getTelegramConfig: async () => ({ apiId:1, apiHash:'test', sessionFile:join(directory,'session') }), getWhatsAppConfig: async () => ({ baseUrl:'http://private-sidecar:8080',sessionId:'fixed',clientId:'voxdock' }) };
}
it('waits for Telegram code and password without exposing secrets, holds one lease and releases after completion', async () => {
 const deps = await dependencies();
 const service = createConnectionService({ ...deps, telegramAuthorize: async (_config, prompts) => {
  expect(await prompts.phoneNumber()).toBe('+12345678901');
  expect(await prompts.phoneCode()).toBe('12345');
  expect(await prompts.password()).toBe('private'); return 'account';
 } });
 const flow = await service.startTelegram('+12345678901');
 await vi.waitFor(async () => expect((await service.flow(flow.id)).state).toBe('code_required'));
 await expect(service.startTelegram('+12345678901')).rejects.toThrow('connection_operation_active');
 await service.submit(flow.id,'code','12345');
 await vi.waitFor(async () => expect((await service.flow(flow.id)).state).toBe('password_required'));
 await service.submit(flow.id,'password','private');
 await vi.waitFor(async () => expect((await service.flow(flow.id)).state).toBe('connected'));
 expect(deps.release).toHaveBeenCalledExactlyOnceWith(true);
 expect(JSON.stringify(await service.flow(flow.id))).not.toContain('private');
 await expect(service.submit(flow.id,'password','private')).rejects.toThrow('connection_challenge_stale');
});
it('cancels a pending Telegram prompt before releasing the runtime lease', async () => {
 const deps = await dependencies(); let settled = false;
 const service = createConnectionService({ ...deps, telegramAuthorize: async (_, prompts) => { try { await prompts.phoneCode(); return 'account'; } finally { settled = true; } } });
 const flow = await service.startTelegram('+12345678901');
 await vi.waitFor(async () => expect((await service.flow(flow.id)).state).toBe('code_required'));
 expect((await service.cancel(flow.id)).state).toBe('cancelled'); expect(settled).toBe(true);
 expect(deps.release).toHaveBeenCalledWith(true);
});
it('polls only fixed sidecar routes, reuses paired sessions, and keeps uncertain cleanup blocked', async () => {
 const deps = await dependencies();
 const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({paired:false,state:'qr',qr:'sensitive-qr'})).mockRejectedValueOnce(new Error('raw upstream secret'));
 const service = createConnectionService({...deps, fetch: transport});
 const flow = await service.startWhatsApp(); expect(flow.state).toBe('starting');
 const cancelled = await service.cancel(flow.id); expect(cancelled.qr).toBeUndefined(); expect(cancelled.error).toContain('connection_cleanup_required');
 expect(deps.release).toHaveBeenCalledWith(false);
 expect(String(transport.mock.calls[0]![0])).toBe('http://private-sidecar:8080/api/voxdock/sessions/fixed/connect');
 expect(JSON.stringify(cancelled)).not.toContain('raw upstream');
 const paired = vi.fn<typeof fetch>().mockResolvedValue(Response.json({paired:true,state:'open'}));
 const reconnect = createConnectionService({...deps, fetch:paired});
 const reconnectFlow = await reconnect.startWhatsApp();
 await vi.waitFor(async () => expect((await reconnect.flow(reconnectFlow.id)).state).toBe('connected')); expect(paired).toHaveBeenCalledTimes(1);
});
it('rejects arbitrary upstream origins and malformed route secrets; challenge responses are no-store', async () => {
 expect(() => new WhatsAppConnection({baseUrl:'http://host/path',sessionId:'a',clientId:'b'})).toThrow();
 const deps = await dependencies(); const service = createConnectionService({...deps,telegramAuthorize:async () => { throw new Error('Not called'); },fetch:vi.fn<typeof fetch>().mockResolvedValue(Response.json({paired:false,state:'qr',qr:'secret'}))});
 const app = Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}}); registerConnectionRoutes(app,'/admin/v1',service);
 expect((await app.inject({method:'POST',url:'/admin/v1/connections/telegram/login',payload:{phone:'+12345678901',api_hash:'secret'}})).statusCode).toBe(400);
 const response = await app.inject({method:'POST',url:'/admin/v1/connections/whatsapp/connect',payload:{}});
 expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
 await service.close(); await app.close();
});
it('expires challenges and confirms sidecar cancellation before releasing', async () => {
 const deps = await dependencies();
 vi.useFakeTimers();
 const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({paired:false,state:'qr',qr:'secret'})).mockResolvedValueOnce(Response.json({paired:false,state:'disconnected'}));
 const service = createConnectionService({...deps,fetch:transport,ttlMs:1000});
 const flow = await service.startWhatsApp();
 await vi.advanceTimersByTimeAsync(1001);
 expect((await service.flow(flow.id)).state).toBe('expired');
 expect((await service.flow(flow.id)).qr).toBeUndefined();
 expect(deps.release).toHaveBeenCalledWith(true);
 await expect(service.submit(flow.id,'code','1234')).rejects.toThrow('connection_challenge_stale');
});
it('drains an in-flight connect before disconnect and never releases safe while connect is pending', async () => {
 const deps = await dependencies(); let resolveConnect!: (value: Response) => void;
 const transport = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { resolveConnect = resolve; })).mockResolvedValueOnce(Response.json({paired:false,state:'disconnected'}));
 const service = createConnectionService({...deps,fetch:transport});
 const flow = await service.startWhatsApp();
 const cancellation = service.cancel(flow.id);
 await Promise.resolve(); expect(transport).toHaveBeenCalledTimes(1); expect(deps.release).not.toHaveBeenCalled();
 resolveConnect(Response.json({paired:false,state:'qr',qr:'late secret'}));
 expect((await cancellation).state).toBe('cancelled');
 expect(transport).toHaveBeenCalledTimes(2); expect(deps.release).toHaveBeenCalledExactlyOnceWith(true);
});
it('keeps timed-out connect cancellation blocked even if transport ignores abort and resolves late', async () => {
 const deps = await dependencies(); vi.useFakeTimers(); let resolveConnect!: (value: Response) => void;
 const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { resolveConnect = resolve; }));
 const service = createConnectionService({...deps,fetch:transport});
 const flow = await service.startWhatsApp(); const cancellation = service.cancel(flow.id);
 await vi.advanceTimersByTimeAsync(10001); expect((await cancellation).error).toBe('connection_cleanup_required');
 expect(deps.release).toHaveBeenCalledExactlyOnceWith(false); expect(transport).toHaveBeenCalledTimes(1);
 resolveConnect(Response.json({paired:true,state:'open'})); await vi.advanceTimersByTimeAsync(0);
 expect(deps.release).toHaveBeenCalledTimes(1);
});
it('bounds sidecar response bytes and uses a three second read-only status deadline', async () => {
 const config = {baseUrl:'http://private-sidecar:8080',sessionId:'fixed',clientId:'voxdock'};
 await expect(new WhatsAppConnection(config,vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(65537)))).request('status')).rejects.toThrow('exceeds limit');
 vi.useFakeTimers(); const request = new WhatsAppConnection(config,vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))).request('status');
 const rejected = expect(request).rejects.toThrow('timed out'); await vi.advanceTimersByTimeAsync(3001); await rejected;
});
it('reads configured account status without mutations and treats unknown status as disconnected', async () => {
 const deps = await dependencies(); const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({paired:true,state:'open'}));
 expect(await createConnectionService({...deps,fetch:transport}).accountStatus()).toEqual({telegram:false,whatsapp:true});
 expect(transport.mock.calls[0]?.[1]?.method).toBe('GET'); expect(deps.acquire).not.toHaveBeenCalled();
 expect(await createConnectionService({...deps,fetch:vi.fn<typeof fetch>().mockRejectedValue(new Error('secret'))}).accountStatus()).toEqual({telegram:false,whatsapp:false});
});
it('shutdown waits for an already terminal flow lifecycle release', async () => {
 const deps = await dependencies(); let finishRelease!: () => void;
 const release = vi.fn(() => new Promise<void>(resolve => { finishRelease = resolve; }));
 const service = createConnectionService({...deps, acquire:async () => release, fetch:vi.fn<typeof fetch>().mockResolvedValue(Response.json({paired:true,state:'open'}))});
 await service.startWhatsApp(); await vi.waitFor(() => expect(release).toHaveBeenCalled());
 let closed = false; const closing = service.close().then(() => { closed = true; });
 await Promise.resolve(); expect(closed).toBe(false);
 finishRelease(); await closing; expect(closed).toBe(true);
});
