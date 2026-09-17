import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply } from 'fastify';
import { registerConsole, type ConsoleOptions } from './console-auth.js';
import { registerConsoleRoutes } from './console-routes.js';
import { createConsoleService } from './console-service.js';
import swagger from '@fastify/swagger';
import { Type } from '@sinclair/typebox';
import {
  CallRequestSchema, CallStatusSchema, DelegationResultSchema, RefSchema,
  type CallRequest, type CallStatus, type Channel, type DelegationResult,
} from '@voxdock/contracts';
import type { BridgeConfig } from '@voxdock/config';
import { CallStore, DomainError } from '@voxdock/core';

export interface BridgeServerOptions {
  config: BridgeConfig;
  console?: ConsoleOptions;
  store: CallStore;
  controlToken: string;
  mode?: 'native' | 'simulation';
  readyChannels?: ReadonlySet<Channel>;
  onCallCreated?: (call: CallStatus) => Promise<void>;
  onEnd?: (call: CallStatus) => Promise<void>;
  onResult?: (result: DelegationResult) => Promise<void>;
}

const idParams = Type.Object({ call_id: RefSchema });
const tokenDigest = (value: string) => createHash('sha256').update(value).digest();

export async function createBridgeServer(options: BridgeServerOptions) {
  if (options.controlToken.length < 32 || /\s/.test(options.controlToken)) {
    throw new Error('A control token of at least 32 non-whitespace characters is required');
  }
  const { config, store } = options;
  const ready = options.readyChannels ?? new Set<Channel>();
  const activeTargets = config.targets.filter(t => t.enabled && config.channels[t.channel].enabled);
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  let closing = false;
  app.addHook('onClose', async () => { closing = true; });
  const expected = tokenDigest(`Bearer ${options.controlToken}`);
  await app.register(swagger, { openapi: { info: { title: 'VoxDock control API', version: '1.0.0' } } });
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url === '/healthz') return;
    const route = request.routeOptions.url ?? '';
    if (route.startsWith('/admin/v1/') || route.startsWith('/v1/console/')) {
      reply.header('cache-control', 'no-store');
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    }
    if (options.console && (route.startsWith('/admin/v1/') || route.startsWith('/console') || route === '/')) return;
    const authorization = request.headers.authorization ?? '';
    if (!timingSafeEqual(tokenDigest(authorization), expected)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: error.code });
    if (typeof error === 'object' && error !== null) {
      if (('validation' in error && error.validation) || ('statusCode' in error && error.statusCode === 400)) return reply.code(400).send({ error: 'invalid_request' });
      if ('statusCode' in error && error.statusCode === 429) return reply.code(429).send({ error: 'rate_limited' });
      if ('statusCode' in error && error.statusCode === 413) return reply.code(413).send({ error: 'body_too_large' });
    }
    return reply.code(500).send({ error: 'internal_error' });
  });
  const getCall = (id: string) => {
    const call = store.getCall(id);
    if (!call) throw new DomainError('call_not_found', 404);
    return call;
  };
  const failDispatch = (callId: string) => {
    if (closing) return;
    const call = store.getCall(callId);
    if (!call || call.state === 'ended' || call.state === 'uncertain') return;
    store.transition(callId, call.state === 'requested' ? 'ended' : 'uncertain', { reason: 'dispatch_failed' });
  };
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/v1/openapi.json', async () => app.swagger());
  app.get('/v1/capabilities', async () => ({
    schema_version: 1, implementation_version: '0.1.0', mode: options.mode ?? 'native',
    calling_enabled: config.calling.enabled && !store.isPaused(false),
    max_concurrent_calls: 1,
    channels: Object.fromEntries((['telegram', 'whatsapp'] as const).map(channel => [channel, {
      enabled: config.channels[channel].enabled, ready: ready.has(channel),
      reason: ready.has(channel) ? null : 'adapter_not_ready',
    }])),
  }));
  app.get('/v1/targets', async () => activeTargets.map(t => ({
    id: t.id, channel: t.channel, account_ref: t.account_ref, principal_ref: t.principal_ref, enabled: t.enabled,
  })));
  app.get('/v1/calls', async () => ({ calls: store.listCalls() }));
  app.post<{ Body: CallRequest }>('/v1/calls', {
    schema: { body: CallRequestSchema, response: { 202: CallStatusSchema } },
  }, async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) {
      return reply.code(400).send({ error: 'idempotency_key_required' });
    }
    const target = activeTargets.find(t => t.id === request.body.target_id);
    const result = store.createCall('operator', key, request.body, {
      enabled: config.calling.enabled && !store.isPaused(false) && !!target && ready.has(target.channel) && !!options.onCallCreated,
      allowedTargets: new Set(activeTargets.map(t => t.id)), maxTtlSeconds: config.calling.max_request_ttl_seconds,
      ...(target ? { channel: target.channel } : {}),
    });
    if (!result.replayed && options.onCallCreated) {
      const start = options.onCallCreated;
      setImmediate(() => { if (closing) return; void start(result.call).catch(() => failDispatch(result.call.call_id)); });
    }
    return reply.code(202).send(result.call);
  });
  app.get<{ Params: { call_id: string } }>('/v1/calls/:call_id', {
    schema: { params: idParams, response: { 200: CallStatusSchema } },
  }, async request => getCall(request.params.call_id));
  const endCall = (id: string, reply: FastifyReply) => {
    const call = getCall(id);
    if (call.state === 'ended' || call.state === 'ending') return call;
    if (call.state === 'requested') return store.transition(call.call_id, 'ended', { reason: 'cancelled_before_dial' });
    if (!options.onEnd) return reply.code(409).send({ error: 'reconciliation_required' });
    const ending = store.transition(call.call_id, 'ending');
    setImmediate(() => { if (closing) return; void options.onEnd!(ending).catch(() => failDispatch(call.call_id)); });
    return reply.code(202).send(ending);
  };
  app.post<{ Params: { call_id: string } }>('/v1/calls/:call_id/end', { schema: { params: idParams } }, async (request, reply) => endCall(request.params.call_id, reply));
  const consoleService = createConsoleService(options);
  app.post('/v1/control/pause', async () => consoleService.pause());
  app.post('/v1/control/resume', async () => consoleService.resume());
  registerConsoleRoutes(app, '/v1/console', options, endCall);
  if (options.console) await registerConsole(app, options.console, admin => registerConsoleRoutes(admin, '', options, endCall));
  app.get<{ Querystring: { after?: string; limit?: string } }>('/v1/events', async (request, reply) => {
    const { after = '0', limit = '100' } = request.query;
    if (!/^\d+$/.test(after) || !/^\d+$/.test(limit) || !Number.isSafeInteger(Number(after)) || Number(limit) < 1 || Number(limit) > 500) {
      return reply.code(400).send({ error: 'invalid_cursor' });
    }
    const events = store.events(Number(after), Number(limit));
    return { events, next_cursor: events.at(-1)?.cursor ?? Number(after) };
  });
  app.get<{ Params: { call_id: string } }>('/v1/calls/:call_id/record', { schema: { params: idParams } }, async request => ({
    schema_version: 1, mode: options.mode ?? 'native', ...store.getRecord(request.params.call_id),
  }));
  app.post<{ Params: { call_id: string; delegation_id: string }; Body: DelegationResult }>(
    '/v1/calls/:call_id/delegations/:delegation_id/results', {
      schema: { params: Type.Object({ call_id: RefSchema, delegation_id: RefSchema }), body: DelegationResultSchema },
    }, async (request, reply) => {
      if (request.body.call_id !== request.params.call_id || request.body.delegation_id !== request.params.delegation_id) {
        return reply.code(409).send({ error: 'result_identity_mismatch' });
      }
      const result = store.recordResult(request.body);
      if (!result.replayed && result.playback_status === 'eligible' && options.onResult) {
        // Eligibility is advisory; the session coordinator rechecks immediately before speaking.
        await options.onResult(result.result);
      }
      return { accepted: true, playback_status: result.playback_status, replayed: result.replayed };
    },
  );
  return app;
}
