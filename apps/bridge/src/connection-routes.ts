import { Type } from '@sinclair/typebox';
import { DomainError } from '@voxdock/core';
import type { FastifyInstance } from 'fastify';
import { ConnectionError, type ConnectionService } from './connection-service.js';
const strict = { additionalProperties: false };
const empty = Type.Object({}, strict);
const challenge = Type.Object({ id: Type.String({ format: 'uuid' }) }, strict);
export function registerConnectionRoutes(app: FastifyInstance, prefix: string, service: ConnectionService): void {
  const invoke = async (reply: import('fastify').FastifyReply, action: () => Promise<unknown>) => {
    reply.header('cache-control', 'no-store');
    try { return await action(); } catch (error) {
      if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: error.code });
      return reply.code(error instanceof ConnectionError ? error.statusCode : 409).send({ error: error instanceof ConnectionError ? error.message : 'connection_operation_unavailable' });
    }
  };
  app.post<{ Body: { phone: string } }>(`${prefix}/connections/telegram/login`, { schema: { body: Type.Object({ phone: Type.String({ pattern: '^\\+[1-9][0-9]{6,14}$' }) }, strict) } }, (request, reply) => invoke(reply, () => service.startTelegram(request.body.phone)));
  app.post(`${prefix}/connections/whatsapp/connect`, { schema: { body: empty } }, (_, reply) => invoke(reply, () => service.startWhatsApp()));
  app.post(`${prefix}/connections/whatsapp/unlink`, { schema: { body: empty } }, (_, reply) => invoke(reply, () => service.unlinkWhatsApp()));
  app.get<{ Params: { id: string } }>(`${prefix}/connections/flows/:id`, { schema: { params: challenge } }, (request, reply) => invoke(reply, () => service.flow(request.params.id)));
  for (const field of ['code', 'password'] as const) {
    app.post<{ Params: { id: string }; Body: Record<string, string> }>(`${prefix}/connections/flows/:id/${field}`, { schema: { params: challenge, body: Type.Object({ [field]: Type.String({ minLength: 1, maxLength: field === 'code' ? 16 : 256 }) }, strict) } }, (request, reply) => invoke(reply, () => service.submit(request.params.id, field, request.body[field]!)));
  }
  app.post<{ Params: { id: string } }>(`${prefix}/connections/flows/:id/cancel`, { schema: { params: challenge, body: empty } }, (request, reply) => invoke(reply, () => service.cancel(request.params.id)));
  app.post<{ Params: { channel: 'telegram' | 'whatsapp' } }>(`${prefix}/connections/:channel/disconnect`, { schema: { params: Type.Object({ channel: Type.Union([Type.Literal('telegram'), Type.Literal('whatsapp')]) }, strict), body: empty } }, (request, reply) => invoke(reply, () => service.disconnect(request.params.channel)));
}
