import { Type } from '@sinclair/typebox';
import { AgentCreateSchema, type AgentCreate } from '@voxdock/contracts';
import { DomainError } from '@voxdock/core';
import type { FastifyInstance } from 'fastify';
import type { BridgeServerOptions } from './server.js';
export function registerAgentRoutes(app: FastifyInstance, prefix: string, options: BridgeServerOptions) {
  const credentials = () => {
    if (!options.agents) throw new DomainError('agent_management_unavailable', 503);
    return options.agents;
  };
  app.get(`${prefix}/agents`, async () => ({ agents: credentials().list() }));
  app.post<{ Body: AgentCreate }>(`${prefix}/agents`, { schema: { body: AgentCreateSchema } }, async (request, reply) => {
    if (request.body.allowed_targets.some(id => !options.config.targets.some(target => target.id === id))) throw new DomainError('invalid_target', 400);
    return reply.code(201).send(credentials().create(request.body));
  });
  const schema = { params: Type.Object({ id: Type.String({ format: 'uuid' }) }) };
  app.post<{ Params: { id: string } }>(`${prefix}/agents/:id/rotate`, { schema }, async request => credentials().rotate(request.params.id));
  app.post<{ Params: { id: string } }>(`${prefix}/agents/:id/revoke`, { schema }, async request => credentials().revoke(request.params.id));
}
