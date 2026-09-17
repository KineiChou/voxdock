import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CallStore } from "./index.js";
import type { Delegation, TranscriptFragment } from "@voxdock/contracts";
let directory: string, filename: string, store: CallStore, now: Date;
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
const create = (key: string) =>
  store.createCall("operator", key, request(), {
    ...options,
    channel: "telegram",
  }).call.call_id;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "console-test-"));
  filename = join(directory, "db.sqlite");
  now = new Date("2026-09-16T16:00:00Z");
  store = new CallStore(filename, { now: () => now });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
it("preserves durable duration and uncertainty after acknowledged events expire", () => {
  const id = create("a");
  store.transition(id, "connected");
  now = new Date(now.getTime() + 5000);
  store.transition(id, "uncertain");
  store.transition(id, "ended");
  for (const event of store.events()) store.acknowledgeEvent(event.event_id);
  store.prune({
    metadataBefore: "2027-01-01T00:00:00Z",
    transcriptsBefore: "2027-01-01T00:00:00Z",
  });
  expect(store.consoleCall(id).events).toEqual([]);
  expect(store.consoleCall(id).summary).toMatchObject({
    channel: "telegram",
    actor_kind: "operator",
    connected: true,
    duration_seconds: 5,
    had_uncertain_state: true,
  });
  expect(
    store.consoleOverview({
      days: 1,
      timeZone: "Asia/Tokyo",
      dailySeconds: 100,
    }).attention_calls,
  ).toEqual([]);
});
it("migrates v1 with evidence-only unknown outcomes and retains command replay", () => {
  const input = request(),
    id = store.createCall("operator", "legacy", input, options).call.call_id;
  store.transition(id, "ended");
  const zero = create("zero");
  store.transition(zero, "ended");
  store.close();
  const db = new Database(filename);
  db.prepare("DELETE FROM events WHERE call_id=?").run(id);
  db.exec(
    "DROP TABLE call_facts; DROP TABLE transcript_cursors; PRAGMA user_version=1",
  );
  db.close();
  store = new CallStore(filename, { now: () => now });
  expect(store.consoleCall(id).summary).toMatchObject({
    connected: null,
    duration_seconds: null,
    channel: null,
    actor_kind: null,
    had_uncertain_state: null,
  });
  expect(store.consoleCall(zero).summary).toMatchObject({
    connected: false,
    duration_seconds: 0,
    channel: null,
  });
  expect(store.createCall("operator", "legacy", input, options).replayed).toBe(
    true,
  );
  expect(
    store.consoleOverview({ days: 1, timeZone: "UTC", dailySeconds: 100 })
      .totals,
  ).toMatchObject({
    calls: 2,
    observed_calls: 1,
    unknown_outcomes: 1,
    connection_rate: 0,
  });
});
it("uses terminal observed denominator and local calendar dates with independent usage ledger dates", () => {
  now = new Date("2026-09-16T14:59:00Z");
  const yesterday = create("y");
  store.reserveUsage(yesterday, {
    dailySeconds: 100,
    maxSeconds: 20,
    timeZone: "Asia/Tokyo",
  });
  store.transition(yesterday, "connected");
  now = new Date("2026-09-16T15:01:00Z");
  store.transition(yesterday, "ended");
  store.settleUsage(yesterday, 10);
  const failed = create("f");
  store.transition(failed, "ended");
  const success = create("s");
  store.transition(success, "connected");
  store.transition(success, "ended");
  const active = create("a");
  store.reserveUsage(active, {
    dailySeconds: 100,
    maxSeconds: 30,
    timeZone: "Asia/Tokyo",
  });
  let view = store.consoleOverview({
    days: 1,
    timeZone: "Asia/Tokyo",
    dailySeconds: 100,
  });
  expect(view.period_from).toBe("2026-09-16T15:00:00.000Z");
  expect(view.daily[0]?.date).toBe("2026-09-17");
  expect(view.totals).toMatchObject({
    calls: 3,
    connected_calls: 1,
    observed_calls: 2,
    connection_rate: 0.5,
    settled_live_seconds: 0,
    reserved_live_seconds: 30,
  });
  expect(view.today_usage).toMatchObject({
    reserved_seconds: 30,
    remaining_seconds: 70,
  });
  store.settleUsage(active);
  view = store.consoleOverview({
    days: 7,
    timeZone: "Asia/Tokyo",
    dailySeconds: 100,
  });
  expect(view.totals).toMatchObject({
    settled_live_seconds: 10,
    reserved_live_seconds: 0,
    unknown_live_seconds: 30,
  });
  expect(view.today_usage).toMatchObject({
    unknown_seconds: 30,
    remaining_seconds: 70,
  });
  expect(
    view.daily.find((day) => day.date === "2026-09-16")?.settled_live_seconds,
  ).toBe(10);
});
it("binds stable call cursors to filters and rejects malformed input", () => {
  for (const key of ["a", "b", "c"]) {
    const id = create(key);
    store.transition(id, "ended");
  }
  const first = store.consoleCalls({ limit: 1, channel: "telegram" });
  expect(first.total).toBe(3);
  const second = store.consoleCalls({
    limit: 2,
    channel: "telegram",
    cursor: first.next_cursor!,
  });
  expect(second.items).toHaveLength(2);
  expect(
    new Set([...first.items, ...second.items].map((i) => i.call.call_id)).size,
  ).toBe(3);
  expect(() =>
    store.consoleCalls({ cursor: first.next_cursor!, channel: "unknown" }),
  ).toThrow("invalid_cursor");
  expect(() => store.consoleCalls({ cursor: "?" })).toThrow("invalid_cursor");
  expect(() => store.consoleCalls({ limit: 101 })).toThrow("invalid_limit");
  expect(() => store.consoleCalls({ from: "garbage" })).toThrow(
    "invalid_filter",
  );
});
it("counts only latest result on current delegation context and keeps transcript text separate", () => {
  const id = create("a");
  store.transition(id, "connected");
  const d: Delegation = {
    call_id: id,
    delegation_id: "d",
    principal_ref: "owner",
    context_revision: 1,
    occurred_at: now.toISOString(),
    fragments: [],
    completeness: "partial",
  };
  store.recordDelegation(d);
  store.recordResult({
    call_id: id,
    delegation_id: "d",
    context_revision: 1,
    result_id: "r1",
    revision: 1,
    status: "completed",
    spoken_summary: "Done",
  });
  expect(store.consoleCall(id).summary.delegations.completed).toBe(1);
  store.recordDelegation({ ...d, context_revision: 2 });
  expect(store.consoleCall(id).delegations[0]?.latest_result).toBeNull();
  expect(store.consoleCall(id).summary.delegations).toEqual({
    total: 1,
    pending: 1,
    completed: 0,
    failed: 0,
  });
  store.recordResult({
    call_id: id,
    delegation_id: "d",
    context_revision: 2,
    result_id: "r2",
    revision: 2,
    status: "working",
    spoken_summary: "Working",
  });
  store.recordResult({
    call_id: id,
    delegation_id: "d",
    context_revision: 2,
    result_id: "r3",
    revision: 3,
    status: "failed",
    spoken_summary: "Failed",
  });
  expect(store.consoleCall(id).summary.delegations).toEqual({
    total: 1,
    pending: 0,
    completed: 0,
    failed: 1,
  });
  expect(store.consoleCall(id).delegations[0]?.latest_result?.result_id).toBe(
    "r3",
  );
});
it("paginates transcripts by durable insertion order across sessions with duplicate sequence numbers", () => {
  const id = create("a");
  const fragment = (id: string, session_id: string): TranscriptFragment => ({
    id,
    session_id,
    seq: 1,
    speaker: "user",
    text: "private words",
    start_ms: 0,
    end_ms: 10,
    final: true,
    context_revision: 1,
  });
  store.appendTranscript(id, fragment("f1", "s1"));
  store.appendTranscript(id, fragment("f2", "s2"));
  store.appendTranscript(id, fragment("f3", "s2"));
  const first = store.consoleTranscripts(id, { limit: 1 });
  expect(first.fragments[0]?.id).toBe("f1");
  const rest = store.consoleTranscripts(id, {
    limit: 2,
    cursor: first.next_cursor!,
  });
  expect(rest.fragments.map((f) => f.id)).toEqual(["f2", "f3"]);
  expect(JSON.stringify(store.consoleCall(id))).not.toContain("private words");
});

it("keeps legacy connection time unknown when the retained history begins after connection", () => {
  const id = create("old");
  store.transition(id, "connected");
  now = new Date(now.getTime() + 10000);
  store.transition(id, "connected", { audio_ready: true });
  store.close();
  const db = new Database(filename);
  db.exec(
    "DELETE FROM events WHERE json_extract(body,'$.call_seq')<3; DROP TABLE call_facts; DROP TABLE transcript_cursors; PRAGMA user_version=1",
  );
  db.close();
  store = new CallStore(filename, { now: () => now });
  store.transition(id, "connected", { live_ready: true });
  store.transition(id, "ended");
  expect(store.consoleCall(id).summary).toMatchObject({
    connected: true,
    connected_at: null,
    duration_seconds: null,
    had_uncertain_state: null,
  });
});
it("keeps transcript cursors monotonic after retention removes the latest row", () => {
  const id = create("retained");
  const f = (id: string): TranscriptFragment => ({
    id,
    session_id: "s",
    seq: 0,
    speaker: "user",
    text: "text",
    start_ms: 0,
    end_ms: 1,
    final: true,
    context_revision: 1,
  });
  store.appendTranscript(id, f("a"));
  store.appendTranscript(id, f("b"));
  const page = store.consoleTranscripts(id, { limit: 1 });
  store.prune({
    metadataBefore: "2027-01-01T00:00:00Z",
    transcriptsBefore: "2027-01-01T00:00:00Z",
  });
  // Expired recordings cannot resume; another call still receives a new insertion sequence.
  store.transition(id, "ended");
  const next = create("next");
  store.appendTranscript(next, f("c"));
  const db = new Database(filename);
  expect(
    (
      db.prepare("SELECT max(cursor) n FROM transcript_cursors").get() as {
        n: number;
      }
    ).n,
  ).toBe(3);
  db.close();
  expect(
    store.consoleTranscripts(id, { cursor: page.next_cursor! }).availability,
  ).toBe("expired");
  expect(() =>
    store.consoleTranscripts(next, { cursor: page.next_cursor! }),
  ).toThrow("invalid_cursor");
});

it("supports transcript pages of 200 while keeping call pages bounded at 100", () => {
  const id = create("transcript-limit");
  for (let index = 0; index < 201; index++) {
    store.appendTranscript(id, {
      id: `fragment-${index}`,
      session_id: "session",
      seq: index,
      speaker: "user",
      text: "Transcript fragment",
      start_ms: index,
      end_ms: index + 1,
      final: true,
      context_revision: 1,
    });
  }
  const first = store.consoleTranscripts(id, { limit: 200 });
  expect(first.fragments).toHaveLength(200);
  expect(
    store.consoleTranscripts(id, { limit: 200, cursor: first.next_cursor! })
      .fragments,
  ).toHaveLength(1);
  expect(() => store.consoleTranscripts(id, { limit: 201 })).toThrow(
    "invalid_limit",
  );
  expect(() => store.consoleCalls({ limit: 200 })).toThrow("invalid_limit");
});

it("rejects an overview timezone inconsistent with the durable usage ledger", () => {
  const id = create("zone-conflict");
  store.reserveUsage(id, {
    dailySeconds: 100,
    maxSeconds: 20,
    timeZone: "Asia/Tokyo",
  });
  store.settleUsage(id, 10);
  expect(() =>
    store.consoleOverview({ days: 1, timeZone: "UTC", dailySeconds: 100 }),
  ).toThrow("usage_timezone_conflict");
  expect(
    store.consoleOverview({
      days: 1,
      timeZone: "Asia/Tokyo",
      dailySeconds: 100,
    }).today_usage.settled_seconds,
  ).toBe(10);
});

it.each([
  [
    "2026-03-08T18:00:00Z",
    "2026-03-08T05:00:00.000Z",
    "2026-03-09T04:00:00.000Z",
    23,
  ],
  [
    "2026-11-01T18:00:00Z",
    "2026-11-01T04:00:00.000Z",
    "2026-11-02T05:00:00.000Z",
    25,
  ],
])(
  "uses local midnight through DST on %s",
  (timestamp, expectedStart, nextStart, hours) => {
    now = new Date(timestamp);
    const view = store.consoleOverview({
      days: 1,
      timeZone: "America/New_York",
      dailySeconds: 100,
    });
    expect(view.period_from).toBe(expectedStart);
    now = new Date(nextStart);
    const next = store.consoleOverview({
      days: 1,
      timeZone: "America/New_York",
      dailySeconds: 100,
    });
    expect(next.period_from).toBe(nextStart);
    expect(
      (Date.parse(next.period_from) - Date.parse(view.period_from)) / 3600000,
    ).toBe(hours);
  },
);
