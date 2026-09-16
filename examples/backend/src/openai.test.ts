import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Delegation } from "@voxdock/contracts";
import { createExampleBackend } from "./server.js";
import { ExampleStore } from "./store.js";
import { OpenAIWorker, modelInput, responseText } from "./openai.js";
const directories: string[] = [];
function database() { const dir = mkdtempSync(join(tmpdir(), "voxdock-openai-")); directories.push(dir); return join(dir, "backend.sqlite"); }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const delegation: Delegation = {
  call_id: "call", delegation_id: "delegation", context_revision: 1, principal_ref: "owner", occurred_at: "2026-09-17T12:00:00Z", completeness: "partial",
  fragments: [{ id: "fragment", session_id: "session", speaker: "user", seq: 0, start_ms: 0, end_ms: 1, text: "你好", final: false, context_revision: 1 }],
};
const success = () => Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "你好！" }] }] });
it("durably accepts before provider completes, deduplicates paid work and delivers its durable callback", async () => {
  const path = database(); let requests = 0; let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const delivered: unknown[] = [];
  const app = createExampleBackend({ databasePath: path, requestToken: "request", eventSigningKey: "signing", language: "zh-CN",
    openai: { apiKey: "fake", fetch: async (url, init) => {
      requests++; expect(url).toBe("https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "gpt-5.6-sol", store: false, reasoning: { effort: "low" }, max_output_tokens: 1024 });
      expect(JSON.parse(body.input)).toEqual([{ speaker: "user", text: "你好" }]);
      expect(body.tools).toBeUndefined(); await pending; return success();
    } },
    callbacks: { bridgeBaseUrl: "http://bridge", controlToken: "c".repeat(32), fetch: async (_url, init) => {
      delivered.push(JSON.parse(String(init?.body))); return Response.json({ accepted: true, replayed: false, playback_status: "not_played" });
    } },
  });
  try {
    const send = () => app.inject({ method: "POST", url: "/voice/v1/delegations", headers: { authorization: "Bearer request" }, payload: delegation });
    const invalid = await app.inject({ method: "POST", url: "/voice/v1/delegations", headers: { authorization: "Bearer request" }, payload: { ...delegation, fragments: [] } });
    expect(invalid.statusCode).toBe(400); expect(requests).toBe(0);
    const first = await send(); expect(first.statusCode).toBe(200); expect(first.json().status).toBe("accepted");
    const running = app.runModelWork();
    expect((await send()).json()).toEqual(first.json()); expect(requests).toBe(1);
    expect((await app.inject({ url: "/simulation/jobs", headers: { authorization: "Bearer request" } })).statusCode).toBe(404);
    release(); await running; await app.runModelWork(); expect(requests).toBe(1);
    expect(await app.deliverCallbacks()).toEqual({ accepted: 1, failed: 0 });
    expect(delivered).toMatchObject([{ status: "completed", spoken_summary: "你好！", revision: 2 }]);
  } finally { release(); await app.close(); }
  const privateDb = new Database(path);
  expect(privateDb.prepare("SELECT input,state FROM model_work").get()).toEqual({ input: null, state: "terminal" });
  privateDb.close();
  const reopened = new ExampleStore(path);
  expect(reopened.jobs()[0]?.status).toBe("completed"); expect(reopened.callbacks()[0]?.status).toBe("accepted"); reopened.close();
});
it("fails interrupted work after restart without resending and resumes only queued work", async () => {
  const path = database(); let store = new ExampleStore(path);
  store.delegate(delegation, modelInput(delegation)); store.claimModelWork(); store.close();
  store = new ExampleStore(path); let count = 0;
  const worker = new OpenAIWorker(store, { apiKey: "fake", fetch: async () => { count++; return success(); } });
  await worker.runOnce(); expect(count).toBe(0); expect(store.pendingCallbacks()[0]).toMatchObject({ status: "failed" });
  expect(store.pendingCallbacks()[0]?.spoken_summary).toContain("unknown");
  store.delegate(delegation, modelInput(delegation)); await worker.runOnce(); expect(count).toBe(0);
  store.delegate({ ...delegation, context_revision: 2 }, modelInput(delegation)); await worker.runOnce(); expect(count).toBe(1);
  expect(store.callbacks().map((row) => row.status)).toEqual(["superseded", "pending"]);
  await worker.close(); store.close();
});
it("suppresses superseded in-flight output and never retries provider failure", async () => {
  const store = new ExampleStore(database()); let release!: () => void; let count = 0;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const worker = new OpenAIWorker(store, { apiKey: "fake", fetch: async () => { count++; if (count === 1) { await waiting; return success(); } return Response.json({ private: "must not leak" }, { status: 500 }); } });
  store.delegate(delegation, modelInput(delegation)); const active = worker.runOnce();
  store.delegate({ ...delegation, context_revision: 2 }, modelInput(delegation)); release(); await active;
  expect(store.pendingCallbacks()).toMatchObject([{ context_revision: 2, status: "failed" }]);
  await worker.runOnce(); expect(count).toBe(2); expect(JSON.stringify(store.pendingCallbacks())).not.toContain("must not leak");
  await worker.close(); store.close();
});
it("rejects empty, incomplete, oversized responses and bounds transcript input", () => {
  for (const body of [null, {}, { status: "incomplete", output: [] }, { status: "completed", output: [] }, { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(4001) }] }] }]) expect(() => responseText(body)).toThrow();
  expect(modelInput({ ...delegation, fragments: [] })).toBeUndefined();
  expect(modelInput({ ...delegation, fragments: [ { ...delegation.fragments[0]!, text: "界".repeat(16000) } ] })).toBeUndefined();
});
it("aborts on shutdown with an honest terminal result instead of retrying", async () => {
  const store = new ExampleStore(database()); store.delegate(delegation, modelInput(delegation));
  const worker = new OpenAIWorker(store, { apiKey: "fake", fetch: async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }) });
  void worker.runOnce(); await worker.close();
  expect(store.pendingCallbacks()[0]?.status).toBe("failed"); store.close();
});

it("times out uncertain requests without automatic retry", async () => {
  const store = new ExampleStore(database()); store.delegate(delegation, modelInput(delegation)); let count = 0;
  const worker = new OpenAIWorker(store, { apiKey: "fake", timeoutMs: 5, fetch: async (_url, init) => new Promise((_resolve, reject) => { count++; init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }) });
  await worker.runOnce(); await worker.runOnce(); expect(count).toBe(1);
  expect(store.pendingCallbacks()[0]?.status).toBe("failed"); await worker.close(); store.close();
});
