import { describe, expect, it } from "vitest";
import { CallStore } from "@voxdock/core";
import type { Delegation, DelegationResult } from "@voxdock/contracts";
import { BackendClient } from "./client.js";
import { OutboxWorker } from "./outbox.js";
import { verifyEvent } from "./auth.js";
const now = new Date("2026-09-16T12:00:00Z");
const delegation: Delegation = {
  call_id: "call",
  delegation_id: "delegation",
  context_revision: 5,
  principal_ref: "owner",
  occurred_at: now.toISOString(),
  fragments: [],
  completeness: "final",
};
const result: DelegationResult = {
  context_revision: 5,
  call_id: "call",
  delegation_id: "delegation",
  result_id: "result",
  revision: 2,
  status: "accepted",
  spoken_summary: "Received.",
};
const config = {
  baseUrl: "http://fixed-backend",
  requestToken: "request-secret",
  eventSigningKey: "event-secret",
  now: () => now,
};
describe("backend correlation and transport", () => {
  it("separates business result revisions from context revisions and rejects cross-call responses", async () => {
    const client = new BackendClient({
      ...config,
      fetch: async () => Response.json(result),
    });
    expect((await client.delegate(delegation)).revision).toBe(2);
    const wrong = new BackendClient({
      ...config,
      fetch: async () => Response.json({ ...result, call_id: "other" }),
    });
    await expect(wrong.delegate(delegation)).rejects.toThrow(
      "backend_delegation_mismatch",
    );
    const stale = new BackendClient({
      ...config,
      fetch: async () => Response.json({ ...result, context_revision: 4 }),
    });
    await expect(stale.delegate(delegation)).rejects.toThrow(
      "backend_delegation_mismatch",
    );
  });
  it("fetches both context phases afresh and rejects a mismatched context reference", async () => {
    const store = new CallStore(":memory:", { now: () => now });
    const call = store.createCall(
      "backend",
      "context-key",
      {
        target_id: "owner",
        correlation_ref: "task",
        context_ref: "context",
        expires_at: "2026-09-16T12:01:00Z",
      },
      { enabled: true, allowedTargets: new Set(["owner"]), maxTtlSeconds: 300 },
    ).call;
    const phases: string[] = [];
    const client = new BackendClient({
      ...config,
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { phase: string };
        phases.push(request.phase);
        return Response.json({
          call_id: call.call_id,
          context_ref: "context",
          context: {
            context_revision: phases.length,
            obsolete: false,
            purpose: "Simulation",
            facts: [],
            language: "en",
          },
        });
      },
    });
    try {
      expect(
        (await client.context(call, "owner", "before_dial")).context_revision,
      ).toBe(1);
      expect(
        (await client.context(call, "owner", "before_greeting"))
          .context_revision,
      ).toBe(2);
      expect(phases).toEqual(["before_dial", "before_greeting"]);
      await expect(
        client.context(
          { ...call, context_ref: "different" },
          "owner",
          "before_greeting",
        ),
      ).rejects.toThrow("backend_context_mismatch");
    } finally {
      store.close();
    }
  });
  it("never follows redirects and caps untrusted response bodies", async () => {
    let redirect: RequestRedirect | undefined;
    const client = new BackendClient({
      ...config,
      fetch: async (_input, init) => {
        redirect = init?.redirect;
        return new Response("x".repeat(65537));
      },
    });
    await expect(client.delegate(delegation)).rejects.toThrow(
      "backend_response_too_large",
    );
    expect(redirect).toBe("error");
  });
  it("times out without asserting business acceptance", async () => {
    const client = new BackendClient({
      ...config,
      timeoutMs: 5,
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        ),
    });
    await expect(client.delegate(delegation)).rejects.toMatchObject({
      code: "backend_timeout",
      acceptance: "unknown",
    });
  });
  it("serializes outbox workers and signs exact replayed event bytes", async () => {
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
    let sent = 0;
    const client = new BackendClient({
      ...config,
      fetch: async (_url, init) => {
        sent++;
        const headers = new Headers(init?.headers);
        const body = String(init?.body);
        expect(
          verifyEvent(
            "event-secret",
            headers.get("x-voxdock-timestamp")!,
            body,
            headers.get("x-voxdock-signature")!,
            now,
          ),
        ).toBe(true);
        await Promise.resolve();
        return Response.json({
          accepted: true,
          event_id: (JSON.parse(body) as { event_id: string }).event_id,
        });
      },
    });
    try {
      await Promise.all([
        new OutboxWorker(client, store).runOnce(),
        new OutboxWorker(client, store).runOnce(),
      ]);
      expect(sent).toBe(1);
      expect(store.pendingEvents()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
