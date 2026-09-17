import { Type, type Static } from "@sinclair/typebox";
export type * from './console.js';
export * from './console-configuration.js';
export type * from './console-account.js';

const object = { additionalProperties: false } as const;
export const RefSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_.:/-]*$",
});
export const TimestampSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$",
});
export const ChannelSchema = Type.Union([
  Type.Literal("telegram"),
  Type.Literal("whatsapp"),
]);
export type Channel = Static<typeof ChannelSchema>;
export const CallStateSchema = Type.Union(
  (
    [
      "requested",
      "dialing",
      "ringing",
      "connected",
      "ending",
      "ended",
      "uncertain",
    ] as const
  ).map((state) => Type.Literal(state)),
);
export type CallState =
  | "requested"
  | "dialing"
  | "ringing"
  | "connected"
  | "ending"
  | "ended"
  | "uncertain";
export const CallRequestSchema = Type.Object(
  {
    target_id: RefSchema,
    correlation_ref: RefSchema,
    context_ref: RefSchema,
    expires_at: TimestampSchema,
  },
  object,
);
export type CallRequest = Static<typeof CallRequestSchema>;
export const TargetSchema = Type.Object(
  {
    id: RefSchema,
    channel: ChannelSchema,
    account_ref: RefSchema,
    principal_ref: RefSchema,
    enabled: Type.Boolean(),
    label: Type.Optional(Type.String({ maxLength: 100 })),
  },
  object,
);
export type Target = Static<typeof TargetSchema>;
export const CallStatusSchema = Type.Object(
  {
    call_id: RefSchema,
    target_id: RefSchema,
    direction: Type.Union([Type.Literal("inbound"), Type.Literal("outbound")]),
    correlation_ref: RefSchema,
    context_ref: RefSchema,
    state: CallStateSchema,
    revision: Type.Integer({ minimum: 1 }),
    audio_ready: Type.Boolean(),
    live_ready: Type.Boolean(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    expires_at: TimestampSchema,
    reason: Type.Optional(Type.String({ maxLength: 200 })),
    provider_call_ref: Type.Optional(RefSchema),
  },
  object,
);
export type CallStatus = Omit<Static<typeof CallStatusSchema>, "state"> & {
  state: CallState;
};
export const CallEventSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    event_id: RefSchema,
    cursor: Type.Integer({ minimum: 1 }),
    call_id: RefSchema,
    call_seq: Type.Integer({ minimum: 1 }),
    occurred_at: TimestampSchema,
    type: Type.String({ minLength: 1, maxLength: 100 }),
    call: CallStatusSchema,
  },
  object,
);
export type CallEvent = Static<typeof CallEventSchema>;
export const TranscriptFragmentSchema = Type.Object(
  {
    id: RefSchema,
    session_id: RefSchema,
    speaker: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    seq: Type.Integer({ minimum: 0 }),
    start_ms: Type.Integer({ minimum: 0 }),
    end_ms: Type.Integer({ minimum: 0 }),
    text: Type.String({ maxLength: 16000 }),
    final: Type.Boolean(),
    context_revision: Type.Integer({ minimum: 1 }),
  },
  object,
);
export type TranscriptFragment = Static<typeof TranscriptFragmentSchema>;
export const DelegationSchema = Type.Object(
  {
    delegation_id: RefSchema,
    call_id: RefSchema,
    principal_ref: RefSchema,
    context_revision: Type.Integer({ minimum: 1 }),
    occurred_at: TimestampSchema,
    fragments: Type.Array(TranscriptFragmentSchema, { maxItems: 1000 }),
    completeness: Type.Union([Type.Literal("partial"), Type.Literal("final")]),
  },
  object,
);
export type Delegation = Static<typeof DelegationSchema>;
export const DelegationResultSchema = Type.Object(
  {
    result_id: RefSchema,
    delegation_id: RefSchema,
    call_id: RefSchema,
    context_revision: Type.Integer({ minimum: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    status: Type.Union(
      (
        [
          "accepted",
          "working",
          "completed",
          "failed",
          "needs_clarification",
        ] as const
      ).map((status) => Type.Literal(status)),
    ),
    spoken_summary: Type.String({ minLength: 1, maxLength: 4000 }),
    business_ref: Type.Optional(RefSchema),
    evidence_urls: Type.Optional(
      Type.Array(Type.String({ pattern: "^https?://", maxLength: 2048 }), {
        maxItems: 20,
      }),
    ),
  },
  object,
);
export type DelegationResult = Static<typeof DelegationResultSchema>;
export const BackendContextSchema = Type.Object(
  {
    context_revision: Type.Integer({ minimum: 1 }),
    obsolete: Type.Boolean(),
    purpose: Type.String({ maxLength: 2000 }),
    facts: Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 50 }),
    language: Type.String({ minLength: 2, maxLength: 35 }),
  },
  object,
);
export type BackendContext = Static<typeof BackendContextSchema>;

export type * from './console-connections.js';
