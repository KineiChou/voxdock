import Fastify from "fastify";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  CallEventSchema,
  DelegationSchema,
  type BackendContext,
  type CallEvent,
  type Delegation,
} from "@voxdock/contracts";
import { tokenMatches, verifyEvent } from "@voxdock/backend";
import { ExampleConflict, ExampleStore } from "./store.js";
const contextRequest = Type.Object(
  {
    call_id: Type.String({ minLength: 1, maxLength: 200 }),
    principal_ref: Type.String({ minLength: 1, maxLength: 200 }),
    context_ref: Type.String({ minLength: 1, maxLength: 200 }),
    phase: Type.Union([
      Type.Literal("before_dial"),
      Type.Literal("before_greeting"),
    ]),
  },
  { additionalProperties: false },
);
export interface ExampleBackendOptions {
  databasePath: string;
  requestToken: string;
  eventSigningKey: string;
  now?: () => Date;
}
export function createExampleBackend(options: ExampleBackendOptions) {
  if (!options.requestToken || !options.eventSigningKey)
    throw new Error("Example authentication required");
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  const store = new ExampleStore(options.databasePath);
  const now = options.now ?? (() => new Date());
  // Keep bytes untouched until signature verification. Reject invalid UTF-8 before JSON decoding.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.addHook("preHandler", async (request, reply) => {
    if (
      !tokenMatches(
        `Bearer ${options.requestToken}`,
        request.headers.authorization,
      )
    )
      return reply.code(401).send({ error: "unauthorized" });
  });
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(
        error instanceof ExampleConflict
          ? 409
          : typeof error === "object" &&
              error !== null &&
              "statusCode" in error &&
              typeof error.statusCode === "number" &&
              error.statusCode >= 400 &&
              error.statusCode < 500
            ? error.statusCode
            : 500,
      )
      .send({
        error: error instanceof ExampleConflict ? "conflict" : "internal_error",
      }),
  );
  app.addHook("onClose", async () => store.close());
  function parse(body: unknown): unknown {
    if (
      !Buffer.isBuffer(body) ||
      !body.equals(Buffer.from(body.toString("utf8"), "utf8"))
    )
      return undefined;
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
  }
  app.post("/voice/v1/context", async (request, reply) => {
    const body = parse(request.body);
    if (!Value.Check(contextRequest, body))
      return reply.code(400).send({ error: "invalid_context_request" });
    const obsolete = body.context_ref.startsWith("obsolete:");
    const context: BackendContext = {
      context_revision: 1,
      obsolete,
      purpose: "Demonstrate an independent simulated backend.",
      facts: [
        `The example backend has ${store.jobs().length} durable simulated jobs. No real business action is performed.`,
      ],
      language: "en",
    };
    return { call_id: body.call_id, context_ref: body.context_ref, context };
  });
  app.post("/voice/v1/delegations", async (request, reply) => {
    const body = parse(request.body);
    if (!Value.Check(DelegationSchema, body))
      return reply.code(400).send({ error: "invalid_delegation" });
    return store.delegate(body as Delegation);
  });
  app.post("/voice/v1/events", async (request, reply) => {
    const timestamp = request.headers["x-voxdock-timestamp"];
    const signature = request.headers["x-voxdock-signature"];
    if (
      !Buffer.isBuffer(request.body) ||
      !request.body.equals(
        Buffer.from(request.body.toString("utf8"), "utf8"),
      ) ||
      typeof timestamp !== "string" ||
      typeof signature !== "string" ||
      !verifyEvent(
        options.eventSigningKey,
        timestamp,
        request.body.toString("utf8"),
        signature,
        now(),
      )
    )
      return reply.code(401).send({ error: "invalid_event_signature" });
    const body = parse(request.body);
    if (
      !Value.Check(CallEventSchema, body) ||
      body.call_id !== body.call.call_id ||
      body.call_seq !== body.call.revision
    )
      return reply.code(400).send({ error: "invalid_event" });
    store.event(body as CallEvent);
    return { accepted: true, event_id: body.event_id };
  });
  app.get("/simulation/jobs", async () => ({
    simulation: true,
    jobs: store.jobs(),
  }));
  return app;
}
