import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RefSchema, type ConsoleCallQuery } from '@voxdock/contracts';
import type { BridgeServerOptions } from './server.js';
import { createConsoleService } from './console-service.js';
import { redactAudit, renderAudit } from './cli-api.js';

const emptyMutation = async (request: FastifyRequest, reply: FastifyReply) => {
  const body = request.body;
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)) return reply.code(400).send({ error: 'invalid_request' });
};
const strict = { additionalProperties: false };
const params = Type.Object({ call_id: RefSchema }, strict);
const cursor = Type.Optional(Type.String({ minLength: 1, maxLength: 1024 }));
const limit = () => Type.Optional(Type.String({ pattern: `^[0-9]{1,3}$` }));
const time = Type.Optional(Type.String({ format: 'date-time', maxLength: 30 }));
export function registerConsoleRoutes(app: FastifyInstance, prefix: string, options: BridgeServerOptions,
  endCall: (id: string, reply: FastifyReply) => unknown) {
  const service = createConsoleService(options);
  app.get(`${prefix}/settings`, async () => service.settings());
  app.get(`${prefix}/connections`, async () => service.connections());
  app.post(`${prefix}/control/pause`, { preValidation: emptyMutation }, async () => service.pause());
  app.post(`${prefix}/control/resume`, { preValidation: emptyMutation }, async () => service.resume());
  app.get<{ Querystring: { days?: '1' | '7' | '30' } }>(`${prefix}/overview`, {
    schema: { querystring: Type.Object({ days: Type.Optional(Type.Union(['1', '7', '30'].map(value => Type.Literal(value)))) }, strict) },
  }, async request => options.store.consoleOverview({ days: Number(request.query.days ?? 7) as 1 | 7 | 30, timeZone: options.config.timezone, dailySeconds: options.config.calling.daily_live_seconds }));
  app.get<{ Querystring: Omit<ConsoleCallQuery, 'limit'> & { limit?: string } }>(`${prefix}/calls`, {
    schema: { querystring: Type.Object({ cursor, limit: limit(),
      channel: Type.Optional(Type.Union(['telegram', 'whatsapp', 'unknown'].map(value => Type.Literal(value)))),
      direction: Type.Optional(Type.Union(['inbound', 'outbound'].map(value => Type.Literal(value)))),
      state: Type.Optional(Type.Union(['requested', 'dialing', 'ringing', 'connected', 'ending', 'ended', 'uncertain'].map(value => Type.Literal(value)))), from: time, to: time }, strict) },
  }, async (request, reply) => {
    const count = Number(request.query.limit ?? 50);
    if (count < 1 || count > 100 || (request.query.from && request.query.to && Date.parse(request.query.from) > Date.parse(request.query.to))) return reply.code(400).send({ error: 'invalid_request' });
    return options.store.consoleCalls({ ...request.query, limit: count });
  });
  app.get<{ Params: { call_id: string } }>(`${prefix}/calls/:call_id`, { schema: { params } }, async request => options.store.consoleCall(request.params.call_id));
  app.get<{ Params: { call_id: string }; Querystring: { cursor?: string; limit?: string } }>(`${prefix}/calls/:call_id/transcripts`, {
    schema: { params, querystring: Type.Object({ cursor, limit: limit() }, strict) },
  }, async (request, reply) => {
    const count = Number(request.query.limit ?? 100);
    if (count < 1 || count > 200) return reply.code(400).send({ error: 'invalid_request' });
    return options.store.consoleTranscripts(request.params.call_id, { ...request.query, limit: count });
  });
  app.get<{ Params: { call_id: string }; Querystring: { format?: 'json' | 'html'; redact?: 'true' | 'false' } }>(`${prefix}/calls/:call_id/export`, {
    schema: { params, querystring: Type.Object({ format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('html')])), redact: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])) }, strict) },
  }, async (request, reply) => {
    const record = options.store.getRecord(request.params.call_id);
    const output = request.query.redact === 'false' ? record : redactAudit(record);
    const format = request.query.format ?? 'json';
    reply.header('content-disposition', `attachment; filename="voxdock-call.${format}"`);
    return format === 'html' ? reply.type('text/html; charset=utf-8').send(renderAudit(output)) : output;
  });
  app.post<{ Params: { call_id: string } }>(`${prefix}/calls/:call_id/end`, { schema: { params }, preValidation: emptyMutation }, async (request, reply) => endCall(request.params.call_id, reply));
}
