import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { DomainError } from '@voxdock/core';
import type { TargetPairingService } from './target-pairing-service.js';
const strict = { additionalProperties: false };
const empty = Type.Object({}, strict);
const flowParams = Type.Object({ id: Type.String({ format: 'uuid' }) }, strict);
export function registerTargetPairingRoutes(app: FastifyInstance, prefix: string, service: TargetPairingService): void {
  const invoke = async (action: () => Promise<unknown>) => {
    try { return await action(); }
    catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('target_pairing_unavailable', 503); }
  };
  const base = `${prefix}/connections/whatsapp`;
  app.get(`${base}/setup`, () => invoke(() => service.setup()));
  app.post<{ Body: { method: 'message' | 'call' } }>(`${base}/target-pairings`, {
    schema: { body: Type.Object({ method: Type.Union([Type.Literal('message'), Type.Literal('call')]) }, strict) },
  }, request => invoke(() => service.start(request.body.method)));
  app.get<{ Params: { id: string } }>(`${base}/target-pairings/:id`, { schema: { params: flowParams } }, request => invoke(() => service.status(request.params.id)));
  app.post<{ Params: { id: string }; Body: { candidate_id: string } }>(`${base}/target-pairings/:id/confirm`, {
    schema: { params: flowParams, body: Type.Object({ candidate_id: Type.String({ format: 'uuid' }) }, strict) },
  }, request => invoke(() => service.confirm(request.params.id, request.body.candidate_id)));
  app.post<{ Params: { id: string } }>(`${base}/target-pairings/:id/cancel`, { schema: { params: flowParams, body: empty } }, request => invoke(() => service.cancel(request.params.id)));
}
