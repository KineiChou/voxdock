import { randomBytes, timingSafeEqual } from 'node:crypto';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { verifyConsolePassword } from './console-password.js';

declare module '@fastify/secure-session' { interface SessionData { id: string } }

export interface ConsoleOptions { passwordHash: string; publicOrigin: string; assetsDirectory: string }
const lifetime = 8 * 60 * 60 * 1000;
const sameToken = (actual: unknown, expected: string) => typeof actual === 'string' && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
export async function registerConsole(app: FastifyInstance, options: ConsoleOptions, routes: (admin: FastifyInstance) => void) {
  const sessions = new Map<string, { csrf: string; expires: number }>();
  let verifying = false;
  const origin = new URL(options.publicOrigin);
  if (origin.origin !== options.publicOrigin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new Error('Invalid console public origin');
  const prune = () => { for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key); };
  await app.register(async admin => {
    await admin.register(secureSession, { key: randomBytes(32), cookieName: 'voxdock_session', expiry: lifetime / 1000,
      cookie: { path: '/admin/v1', httpOnly: true, sameSite: 'strict', secure: origin.protocol === 'https:', maxAge: lifetime / 1000 } });
    await admin.register(rateLimit, { global: false, max: 5, timeWindow: '1 minute', errorResponseBuilder: () => ({ statusCode: 429, error: 'rate_limited' }) });
    admin.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      reply.header('x-content-type-options', 'nosniff');
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      if (mutation && request.headers.origin !== options.publicOrigin) return reply.code(403).send({ error: 'origin_required' });
      if (request.routeOptions.url === '/admin/v1/session' && request.method === 'POST') return;
      const id = request.session.get('id');
      const session = typeof id === 'string' ? sessions.get(id) : undefined;
      if (!session || session.expires <= Date.now()) {
        if (typeof id === 'string') sessions.delete(id);
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (mutation && !sameToken(request.headers['x-csrf-token'], session.csrf)) return reply.code(403).send({ error: 'csrf_required' });
    });
    admin.post<{ Body: { password: string } }>('/session', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { body: Type.Object({ password: Type.String({ minLength: 12, maxLength: 256 }) }, { additionalProperties: false }) },
    }, async (request, reply) => {
      if (verifying) return reply.code(429).send({ error: 'rate_limited' });
      verifying = true;
      let valid = false;
      try { valid = await verifyConsolePassword(request.body.password, options.passwordHash); }
      finally { verifying = false; }
      if (!valid) return reply.code(401).send({ error: 'unauthorized' });
      prune();
      if (sessions.size >= 100) return reply.code(429).send({ error: 'session_limit' });
      const previous = request.session.get('id');
      if (typeof previous === 'string') sessions.delete(previous);
      const id = randomBytes(32).toString('hex');
      const session = { csrf: randomBytes(32).toString('hex'), expires: Date.now() + lifetime };
      sessions.set(id, session);
      request.session.set('id', id);
      return { authenticated: true, csrf_token: session.csrf, expires_at: new Date(session.expires).toISOString() };
    });
    admin.get('/session', async request => {
      const session = sessions.get(request.session.get('id') as string)!;
      return { authenticated: true, csrf_token: session.csrf, expires_at: new Date(session.expires).toISOString() };
    });
    admin.delete('/session', async (request, reply) => {
      sessions.delete(request.session.get('id') as string);
      request.session.delete();
      return reply.code(204).send();
    });
    routes(admin);
    admin.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
  }, { prefix: '/admin/v1' });
  await app.register(staticFiles, { root: options.assetsDirectory, prefix: '/console/', index: 'index.html',
    dotfiles: 'deny', setHeaders: response => {
      response.header('cache-control', 'no-cache');
      response.header('x-content-type-options', 'nosniff');
      response.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    } });
  app.get('/', async (_request, reply) => reply.redirect('/console/'));
  app.get('/console', async (_request, reply) => reply.redirect('/console/'));
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?')[0]!;
    // Only known client routes receive the SPA shell. Missing assets and API paths remain JSON 404s.
    if (request.method === 'GET' && /^\/console\/(?:overview|calls(?:\/[A-Za-z0-9_-]+)?|connections|settings)\/?$/.test(path)) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found' });
  });
}
