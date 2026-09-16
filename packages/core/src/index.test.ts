import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CallStore } from "./index.js";
import type { Delegation, DelegationResult } from "@voxdock/contracts";
let directory: string;
let filename: string;
let store: CallStore;
let now: Date;
const options = {
  enabled: true,
  allowedTargets: new Set(["owner"]),
  maxTtlSeconds: 300,
};
const request = () => ({
  target_id: "owner",
  correlation_ref: "task:1",
  context_ref: "context:1",
  expires_at: new Date(now.getTime() + 60000).toISOString(),
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "voxdock-state-"));
  filename = join(directory, "state.sqlite");
  now = new Date("2026-09-16T12:00:00Z");
  store = new CallStore(filename, { now: () => now });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function connected() {
  const { call } = store.createCall("backend", "first", request(), options);
  return store.transition(call.call_id, "connected", {
    audio_ready: true,
    live_ready: true,
  });
}
describe("durable call identity and capacity", () => {
  it("replays before expiry, pause, capacity or target changes across reopen", () => {
    const input = request();
    const first = store.createCall("backend", "first", input, options);
    store.transition(first.call.call_id, "dialing");
    store.close();
    now = new Date(now.getTime() + 3600000);
    store = new CallStore(filename, { now: () => now });
    const replay = store.createCall("backend", "first", input, {
      enabled: false,
      allowedTargets: new Set(),
      maxTtlSeconds: 1,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.call.call_id).toBe(first.call.call_id);
    expect(replay.call.state).toBe("dialing");
    expect(() =>
      store.createCall(
        "backend",
        "first",
        { ...input, context_ref: "changed" },
        options,
      ),
    ).toThrow("idempotency_conflict");
  });
  it("serializes competing connections and shares inbound/outbound capacity", () => {
    const other = new CallStore(filename, { now: () => now });
    try {
      store.createCall("a", "first", request(), options);
      expect(() =>
        other.createCall("b", "second", request(), {
          ...options,
          direction: "inbound",
        }),
      ).toThrow("call_capacity");
      const db = new Database(filename);
      try {
        expect(() =>
          db.prepare("INSERT INTO calls VALUES ('b','requested','{}')").run(),
        ).toThrow();
      } finally {
        db.close();
      }
    } finally {
      other.close();
    }
  });
  it("rolls back call and command when the event write fails", () => {
    const db = new Database(filename);
    db.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'disk simulation'); END",
    );
    expect(() => store.createCall("a", "first", request(), options)).toThrow(
      "disk simulation",
    );
    expect(store.listCalls()).toEqual([]);
    db.exec("DROP TRIGGER fail_event");
    db.close();
    expect(store.createCall("a", "first", request(), options).replayed).toBe(
      false,
    );
    expect(store.events()).toHaveLength(1);
  });
  it("rejects calendar-invalid expiry and ended state revival", () => {
    expect(() =>
      store.createCall(
        "a",
        "invalid",
        { ...request(), expires_at: "2026-02-30T12:00:00.001Z" },
        options,
      ),
    ).toThrow("invalid_expiry");
    const call = connected();
    store.transition(call.call_id, "ended");
    expect(() => store.transition(call.call_id, "connected")).toThrow(
      "invalid_call_transition",
    );
  });
  it("cancels pre-intent requests and preserves uncertain external intents on recovery", () => {
    const pending = store.createCall("a", "first", request(), options).call;
    expect(store.recover()[0]?.state).toBe("ended");
    const dial = store.createCall("a", "second", request(), options).call;
    store.transition(dial.call_id, "dialing");
    store.close();
    store = new CallStore(filename, { now: () => now });
    expect(store.recover()[0]?.state).toBe("uncertain");
    expect(() => store.createCall("a", "third", request(), options)).toThrow(
      "call_capacity",
    );
    expect(store.getCall(pending.call_id).reason).toBe("cancelled");
  });
});
describe("delegation revisions", () => {
  it("deduplicates updates and keeps late results on the original call without replay", () => {
    const call = connected();
    const delegation: Delegation = {
      call_id: call.call_id,
      delegation_id: "d1",
      principal_ref: "owner",
      context_revision: 1,
      occurred_at: now.toISOString(),
      fragments: [],
      completeness: "partial",
    };
    expect(store.recordDelegation(delegation).replayed).toBe(false);
    expect(store.recordDelegation(delegation).replayed).toBe(true);
    expect(() =>
      store.recordDelegation({ ...delegation, completeness: "final" }),
    ).toThrow("delegation_revision_conflict");
    store.recordDelegation({
      ...delegation,
      context_revision: 2,
      completeness: "final",
    });
    const result: DelegationResult = {
      result_id: "r1",
      delegation_id: "d1",
      call_id: call.call_id,
      revision: 1,
      status: "accepted",
      spoken_summary: "Queued.",
    };
    expect(store.recordResult(result).playback_status).toBe("eligible");
    expect(store.recordResult(result).playback_status).toBe("not_played");
    store.transition(call.call_id, "ended");
    const next = store.createCall("backend", "next", request(), options).call;
    expect(
      store.recordResult({
        ...result,
        result_id: "r2",
        revision: 2,
        status: "completed",
      }).playback_status,
    ).toBe("not_played");
    expect(() =>
      store.recordResult({
        ...result,
        result_id: "r3",
        revision: 3,
        call_id: next.call_id,
      }),
    ).toThrow("delegation_not_found");
    expect(() =>
      store.recordResult({
        ...result,
        result_id: "different",
        spoken_summary: "Different",
      }),
    ).toThrow("result_revision_conflict");
  });
});
describe("outbox and conservative usage", () => {
  it("retries with the same event identity and stops after the deadline", () => {
    connected();
    const event = store.pendingEvents()[0]!;
    expect(store.retryEvent(event.event_id)).toBe("pending");
    expect(
      store.pendingEvents().some((item) => item.event_id === event.event_id),
    ).toBe(false);
    now = new Date(now.getTime() + 86400001);
    expect(store.retryEvent(event.event_id)).toBe("failed");
    expect(
      store.pendingEvents().some((item) => item.event_id === event.event_id),
    ).toBe(false);
  });
  it("holds unknown usage across restart, settles factual totals and blocks overspend", () => {
    const call = connected();
    const budget = { dailySeconds: 600, maxSeconds: 600, timeZone: "UTC" };
    expect(store.reserveUsage(call.call_id, budget)).toBe(600);
    store.settleUsage(call.call_id);
    store.transition(call.call_id, "ended");
    store.close();
    store = new CallStore(filename, { now: () => now });
    const next = store.createCall("backend", "next", request(), options).call;
    expect(() => store.reserveUsage(next.call_id, budget)).toThrow(
      "daily_usage_limit",
    );
    store.settleUsage(call.call_id, 100);
    expect(
      store.reserveUsage(next.call_id, { ...budget, maxSeconds: 500 }),
    ).toBe(500);
    expect(() => store.settleUsage(call.call_id, 0)).toThrow(
      "usage_settlement_conflict",
    );
  });
  it("expires acknowledged terminal event prefixes but retains uncertain identity", () => {
    const call = connected();
    store.transition(call.call_id, "ended");
    for (const event of store.events()) store.acknowledgeEvent(event.event_id);
    const uncertain = store.createCall(
      "backend",
      "next",
      request(),
      options,
    ).call;
    store.transition(uncertain.call_id, "uncertain");
    store.prune({
      metadataBefore: "2026-09-17T00:00:00Z",
      transcriptsBefore: "2026-09-17T00:00:00Z",
    });
    expect(() => store.events(0)).toThrow("cursor_expired");
    expect(store.getCall(uncertain.call_id).state).toBe("uncertain");
  });
});

describe("audit privacy and durable pause", () => {
  it("never persists delegated transcript copies when capture is disabled", () => {
    store.close();
    store = new CallStore(filename, {
      now: () => now,
      persistTranscripts: false,
    });
    const call = connected();
    const fragment = {
      id: "f1",
      session_id: "s1",
      speaker: "user" as const,
      seq: 0,
      start_ms: 0,
      end_ms: 20,
      text: "private utterance",
      final: true,
      context_revision: 1,
    };
    const delegation: Delegation = {
      call_id: call.call_id,
      delegation_id: "d1",
      principal_ref: "owner",
      context_revision: 1,
      occurred_at: now.toISOString(),
      fragments: [fragment],
      completeness: "final",
    };
    store.appendTranscript(call.call_id, fragment);
    expect(
      store.recordDelegation(delegation).delegation.fragments,
    ).toHaveLength(1);
    store.setPaused(true);
    store.close();
    store = new CallStore(filename, { now: () => now });
    expect(store.isPaused(false)).toBe(true);
    const record = store.getRecord(call.call_id);
    expect(record.transcript_availability).toBe("disabled");
    expect(record.transcripts).toEqual([]);
    expect(record.delegations[0]?.fragments).toEqual([]);
    expect(store.recordDelegation(delegation).replayed).toBe(true);
    expect(JSON.stringify(record)).not.toContain("private utterance");
  });
  it("expires copies in delegation fragments and ended result summaries", () => {
    const call = connected();
    const fragment = {
      id: "f1",
      session_id: "s1",
      speaker: "user" as const,
      seq: 0,
      start_ms: 0,
      end_ms: 20,
      text: "private utterance",
      final: true,
      context_revision: 1,
    };
    const delegation: Delegation = {
      call_id: call.call_id,
      delegation_id: "d1",
      principal_ref: "owner",
      context_revision: 1,
      occurred_at: now.toISOString(),
      fragments: [fragment],
      completeness: "final",
    };
    store.appendTranscript(call.call_id, fragment);
    store.recordDelegation(delegation);
    const result: DelegationResult = {
      call_id: call.call_id,
      delegation_id: "d1",
      result_id: "r1",
      revision: 1,
      status: "completed",
      spoken_summary: "private reply",
    };
    store.recordResult(result);
    store.transition(call.call_id, "ended");
    store.prune({
      metadataBefore: "2026-09-17T00:00:00Z",
      transcriptsBefore: "2026-09-17T00:00:00Z",
    });
    const record = store.getRecord(call.call_id);
    expect(record.transcript_availability).toBe("expired");
    expect(record.transcripts).toEqual([]);
    expect(JSON.stringify(record)).not.toContain("private utterance");
    expect(JSON.stringify(record)).not.toContain("private reply");
    expect(store.recordDelegation(delegation).replayed).toBe(true);
    expect(store.recordResult(result).replayed).toBe(true);
  });
});
