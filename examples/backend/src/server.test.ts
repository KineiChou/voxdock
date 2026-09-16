import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CallStore } from "@voxdock/core";
import { BackendClient, signEvent } from "@voxdock/backend";
import { createExampleBackend } from "./server.js";
const now = new Date("2026-09-16T12:00:00Z");
let directory: string;
let app: ReturnType<typeof createExampleBackend>;
const secrets = {
  requestToken: "request-secret",
  eventSigningKey: "event-secret",
  now: () => now,
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "voxdock-backend-"));
  app = createExampleBackend({
    ...secrets,
    databasePath: join(directory, "backend.sqlite"),
  });
});
afterEach(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});
function client() {
  return new BackendClient({
    ...secrets,
    baseUrl: "http://example",
    fetch: async (input, init) => {
      const response = await app.inject({
        method: "POST",
        url: new URL(String(input)).pathname,
        headers: Object.fromEntries(new Headers(init?.headers)),
        payload: String(init?.body),
      });
      return new Response(response.body, { status: response.statusCode });
    },
  });
}
it("persists simulated acceptance and idempotency across restart and hangup", async () => {
  const bridge = new CallStore(":memory:", { now: () => now });
  const call = bridge.createCall(
    "backend",
    "key",
    {
      target_id: "owner",
      correlation_ref: "task",
      context_ref: "context",
      expires_at: "2026-09-16T12:01:00Z",
    },
    { enabled: true, allowedTargets: new Set(["owner"]), maxTtlSeconds: 300 },
  ).call;
  try {
    expect(
      (await client().context(call, "owner", "before_dial")).obsolete,
    ).toBe(false);
    expect(
      (
        await client().context(
          { ...call, context_ref: "obsolete:task" },
          "owner",
          "before_greeting",
        )
      ).obsolete,
    ).toBe(true);
    const delegation = {
      call_id: call.call_id,
      delegation_id: "d1",
      context_revision: 1,
      principal_ref: "owner",
      occurred_at: now.toISOString(),
      fragments: [],
      completeness: "final" as const,
    };
    const receipt = await client().delegate(delegation);
    expect(receipt.status).toBe("accepted");
    await app.close();
    app = createExampleBackend({
      ...secrets,
      databasePath: join(directory, "backend.sqlite"),
    });
    expect(await client().delegate(delegation)).toEqual(receipt);
    bridge.transition(call.call_id, "ended");
    for (const event of bridge.events()) await client().deliverEvent(event);
    const jobs = await app.inject({
      method: "GET",
      url: "/simulation/jobs",
      headers: { authorization: "Bearer request-secret" },
    });
    expect(jobs.json()).toMatchObject({
      simulation: true,
      jobs: [{ id: receipt.business_ref, status: "accepted" }],
    });
    await expect(
      client().delegate({ ...delegation, principal_ref: "different" }),
    ).rejects.toThrow("backend_http_error");
  } finally {
    bridge.close();
  }
});
it("verifies raw-byte HMAC, stale timestamps and conflicting event replay", async () => {
  const store = new CallStore(":memory:", { now: () => now });
  store.createCall(
    "backend",
    "key",
    {
      target_id: "owner",
      correlation_ref: "task",
      context_ref: "context",
      expires_at: "2026-09-16T12:01:00Z",
    },
    { enabled: true, allowedTargets: new Set(["owner"]), maxTtlSeconds: 300 },
  );
  try {
    const event = store.events()[0]!;
    const raw = JSON.stringify(event);
    const timestamp = String(now.getTime() / 1000);
    const send = (
      body: string,
      stamp = timestamp,
      signature = signEvent("event-secret", stamp, body),
    ) =>
      app.inject({
        method: "POST",
        url: "/voice/v1/events",
        headers: {
          authorization: "Bearer request-secret",
          "content-type": "application/json",
          "x-voxdock-timestamp": stamp,
          "x-voxdock-signature": signature,
        },
        payload: body,
      });
    expect((await send(raw)).statusCode).toBe(200);
    expect((await send(raw)).statusCode).toBe(200);
    expect(
      (
        await send(
          raw + " ",
          timestamp,
          signEvent("event-secret", timestamp, raw),
        )
      ).statusCode,
    ).toBe(401);
    expect((await send(raw, String(Number(timestamp) - 301))).statusCode).toBe(
      401,
    );
    expect(
      (await send(JSON.stringify({ ...event, type: "different" }))).statusCode,
    ).toBe(409);
  } finally {
    store.close();
  }
});
