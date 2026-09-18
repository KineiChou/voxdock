import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentCreateSchema, type AgentCreate, type AgentCredential, type AgentTokenResponse } from '@voxdock/contracts';
import { DomainError } from '@voxdock/core';
import { writePrivateFile } from './private-files.js';

type StoredAgent = AgentCredential & { token_hash: string };
const timestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
const storedSchema = Type.Array(Type.Object({
  ...AgentCreateSchema.properties, id: Type.String({ pattern: '^[a-f0-9-]{36}$' }),
  can_end_calls: Type.Boolean(), created_at: timestamp,
  rotated_at: Type.Union([timestamp, Type.Null()]), revoked_at: Type.Union([timestamp, Type.Null()]),
  token_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
}, { additionalProperties: false }), { maxItems: 1000 });
const digest = (token: string) => createHash('sha256').update(token).digest();
const metadata = ({ token_hash: _, ...agent }: StoredAgent): AgentCredential => structuredClone(agent);
export class AgentCredentials {
  private agents: StoredAgent[];
  private readonly filename: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filename = join(directory, 'agent-credentials.json');
    this.agents = existsSync(this.filename) ? JSON.parse(readFileSync(this.filename, 'utf8')) : [];
    if (!Value.Check(storedSchema, this.agents) || new Set(this.agents.map(agent => agent.id)).size !== this.agents.length) throw new Error('invalid_agent_credentials');
  }
  list(): AgentCredential[] { return this.agents.map(metadata); }
  authenticate(token: string): AgentCredential | undefined {
    const hash = digest(token);
    const agent = this.agents.find(candidate => !candidate.revoked_at && timingSafeEqual(hash, Buffer.from(candidate.token_hash, 'hex')));
    return agent ? metadata(agent) : undefined;
  }
  private save(agents: StoredAgent[]) {
    writePrivateFile(this.filename, JSON.stringify(agents) + '\n');
    this.agents = agents;
  }
  create(input: AgentCreate): AgentTokenResponse {
    if (this.agents.length >= 1000) throw new DomainError('agent_limit', 409);
    const token = randomBytes(32).toString('base64url');
    const agent: StoredAgent = { id: randomUUID(), name: input.name.trim(), allowed_targets: [...input.allowed_targets], can_end_calls: input.can_end_calls ?? false, created_at: new Date().toISOString(), rotated_at: null, revoked_at: null, token_hash: digest(token).toString('hex') };
    this.save([...this.agents, agent]);
    return { agent: metadata(agent), token };
  }
  rotate(id: string): AgentTokenResponse {
    const old = this.agents.find(agent => agent.id === id);
    if (!old) throw new DomainError('agent_not_found', 404);
    if (old.revoked_at) throw new DomainError('agent_revoked', 409);
    const token = randomBytes(32).toString('base64url');
    const agent = { ...old, token_hash: digest(token).toString('hex'), rotated_at: new Date().toISOString() };
    this.save(this.agents.map(entry => entry.id === id ? agent : entry));
    return { agent: metadata(agent), token };
  }
  revoke(id: string): AgentCredential {
    const old = this.agents.find(agent => agent.id === id);
    if (!old) throw new DomainError('agent_not_found', 404);
    const agent = { ...old, revoked_at: old.revoked_at ?? new Date().toISOString() };
    this.save(this.agents.map(entry => entry.id === id ? agent : entry));
    return metadata(agent);
  }
}
