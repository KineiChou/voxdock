import { Type, type Static } from '@sinclair/typebox';
export const AgentCreateSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100, pattern: '.*\\S.*' }),
  allowed_targets: Type.Array(Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:/-]*$' }), { minItems: 1, maxItems: 100, uniqueItems: true }),
  can_end_calls: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type AgentCreate = Static<typeof AgentCreateSchema>;
export interface AgentCredential {
  id: string;
  name: string;
  allowed_targets: string[];
  can_end_calls: boolean;
  created_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
}
export interface AgentTokenResponse { agent: AgentCredential; token: string }
