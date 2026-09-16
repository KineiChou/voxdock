import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CallStore } from "@voxdock/core";
import type { Delegation, DelegationResult } from "@voxdock/contracts";
import { ExampleStore } from "./store.js";
import { CallbackWorker } from "./callbacks.js";
import { createExampleBackend } from "./server.js";
let directory: string;
let now: Date;
let example: ExampleStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "voxdock-completion-"));
  now = new Date("2026-09-16T12:00:00Z");
  example = new ExampleStore(join(directory, "backend.sqlite"), () => now);
});
afterEach(() => {
  example.close();
  rmSync(directory, { recursive: true, force: true });
});
const delegation: Delegation = {
  call_id: "call",
  delegation_id: "delegation",
  context_revision: 1,
  principal_ref: "owner",
  occurred_at: "2026-09-16T12:00:00Z",
  fragments: [],
  completeness: "final",
};
it("completes after restart and hangup, retries an uncertain callback with the same durable result", async () => {
  const bridge = new CallStore(":memory:", { now: () => now });
  const call = bridge.createCall(
    "example",
    "key",
    {
      target_id: "owner",
      context_ref: "context",
      correlation_ref: "task",
      expires_at: "2026-09-16T12:01:00Z",
    },
    { enabled: true, allowedTargets: new Set(["owner"]), maxTtlSeconds: 300 },
  ).call;
  bridge.transition(call.call_id, "connected", { live_ready: true });
  const input = { ...delegation, call_id: call.call_id };
  bridge.recordDelegation(input);
  const receipt = example.delegate(input);
  bridge.recordResult(receipt);
  bridge.transition(call.call_id, "ended");
  example.event(bridge.events().at(-1)!);
  expect(example.jobs()[0]?.status).toBe("accepted");
  example.close();
  example = new ExampleStore(join(directory, "backend.sqlite"), () => now);
  const complete = example.complete(receipt.business_ref!, 1);
  expect(complete.result.revision).toBe(2);
  let attempt = 0;
  const seen: string[] = [];
  const worker = new CallbackWorker(example, {
    bridgeBaseUrl: "http://fixed-bridge",
    controlToken: "c".repeat(32),
    fetch: async (url, init) => {
      expect(new URL(String(url)).pathname).toBe(
        `/v1/calls/${call.call_id}/delegations/delegation/results`,
      );
      expect(init?.redirect).toBe("error");
      const result = JSON.parse(String(init?.body)) as DelegationResult;
      seen.push(result.result_id);
      const saved = bridge.recordResult(result);
      expect(saved.playback_status).toBe("not_played");
      if (attempt++ === 0)
        throw new Error("receipt lost after durable acceptance");
      return Response.json({
        accepted: true,
        replayed: saved.replayed,
        playback_status: saved.playback_status,
      });
    },
  });
  try {
    expect(await worker.runOnce()).toEqual({ accepted: 0, failed: 1 });
    expect(example.complete(receipt.business_ref!, 1).replayed).toBe(true);
    now = new Date(now.getTime() + 1001);
    expect(await worker.runOnce()).toEqual({ accepted: 1, failed: 0 });
    expect(seen).toEqual([
      complete.result.result_id,
      complete.result.result_id,
    ]);
    expect(example.callbacks()[0]).toMatchObject({
      status: "accepted",
      receipt: {
        accepted: true,
        playback_status: "not_played",
        replayed: true,
      },
    });
    expect(bridge.getRecord(call.call_id).results).toHaveLength(2);
  } finally {
    await worker.close();
    bridge.close();
  }
});
it("reopens corrected context and supersedes pending old completion without resetting result revisions", () => {
  const receipt = example.delegate(delegation);
  const first = example.complete(receipt.business_ref!, 1);
  const correction = example.delegate({ ...delegation, context_revision: 7 });
  expect(correction.revision).toBe(3);
  expect(correction.context_revision).toBe(7);
  expect(example.jobs()[0]?.status).toBe("accepted");
  expect(example.callbacks()[0]?.status).toBe("superseded");
  expect(() => example.complete(receipt.business_ref!, 1)).toThrow(
    "job_context_conflict",
  );
  const latest = example.complete(receipt.business_ref!, 7);
  expect(latest.result.revision).toBe(4);
  expect(latest.result.context_revision).toBe(7);
  expect(latest.result.result_id).not.toBe(first.result.result_id);
  now = new Date(now.getTime() + 86400001);
  expect(example.pendingCallbacks()).toEqual([]);
  expect(example.callbacks()[1]?.status).toBe("failed");
});
it("exposes only authenticated explicit simulated completion with a bound context revision", async () => {
  const app = createExampleBackend({
    databasePath: join(directory, "http.sqlite"),
    requestToken: "request",
    eventSigningKey: "events",
  });
  const headers = {
    authorization: "Bearer request",
    "content-type": "application/json",
  };
  try {
    const accepted = await app.inject({
      method: "POST",
      url: "/voice/v1/delegations",
      headers,
      payload: JSON.stringify(delegation),
    });
    const receipt = accepted.json<DelegationResult>();
    const url = `/simulation/jobs/${encodeURIComponent(receipt.business_ref!)}/complete`;
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { context_revision: 1 },
        })
      ).statusCode,
    ).toBe(401);
    const complete = await app.inject({
      method: "POST",
      url,
      headers,
      payload: '{"context_revision":1}',
    });
    expect(complete.json()).toMatchObject({
      simulation: true,
      replayed: false,
      result: { status: "completed", context_revision: 1 },
    });
    const replay = await app.inject({
      method: "POST",
      url,
      headers,
      payload: '{"context_revision":1}',
    });
    expect(replay.json()).toMatchObject({
      replayed: true,
      result: { result_id: complete.json().result.result_id },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: '{"context_revision":1,"callback_url":"http://other"}',
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
