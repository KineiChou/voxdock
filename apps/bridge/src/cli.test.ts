import {
  mkdtempSync,
  chmodSync,
  readFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CallStore } from "@voxdock/core";
import { createBridgeServer } from "./server.js";
import { runCli } from "./cli-commands.js";
import { initDirectory, loadConfig, controlToken } from "./cli-files.js";
import { acquireProcessLock } from "./cli-lock.js";
import { startService } from "./cli-service.js";
let root: string;
let configFile: string;
let directory: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "voxdock-cli-"));
  directory = join(root, "instance");
  configFile = initDirectory(directory);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("initializes private paused configuration and reports offline checks without credentials", async () => {
  const token = readFileSync(join(directory, "control.token"), "utf8").trim();
  expect(token.length).toBeGreaterThanOrEqual(32);
  expect(statSync(join(directory, "control.token")).mode & 0o777).toBe(0o600);
  expect(loadConfig(configFile).config.calling.enabled).toBe(false);
  expect(() => initDirectory(directory)).toThrow("initialization_failed");
  let text = "";
  await runCli(["doctor", "--config", configFile], {
    write: (value) => {
      text += value;
    },
    fetch: async () => {
      throw new Error("network forbidden");
    },
  });
  expect(text).toContain("unverified");
  expect(text).not.toContain(token);
  expect(text).not.toContain("telegram_api_hash");
  chmodSync(join(directory, "control.token"), 0o640);
  await expect(
    runCli(["doctor", "--config", configFile], { write: () => {} }),
  ).rejects.toThrow("doctor_checks_failed");
});
it("smokes authenticated CLI status, pause and escaped audit through the control API", async () => {
  const { config } = loadConfig(configFile);
  const store = new CallStore(join(directory, "data", "voxdock.sqlite"));
  const token = controlToken(config, directory);
  const call = store.createCall(
    "backend",
    "key",
    {
      target_id: "owner",
      context_ref: "context",
      correlation_ref: "task",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    },
    { enabled: true, allowedTargets: new Set(["owner"]), maxTtlSeconds: 300 },
  ).call;
  store.transition(call.call_id, "connected");
  store.appendTranscript(call.call_id, {
    id: "f1",
    session_id: "s1",
    speaker: "user",
    seq: 1,
    start_ms: 0,
    end_ms: 20,
    text: '<script>alert("private")</script>',
    final: true,
    context_revision: 1,
  });
  const app = await createBridgeServer({ config, store, controlToken: token });
  const output: string[] = [];
  const dependencies = {
    write: (value: string) => {
      output.push(value);
    },
    fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await app.inject({
        method: (init?.method ?? "GET") as "GET" | "POST",
        url: new URL(String(input)).pathname,
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(init?.body ? { payload: String(init.body) } : {}),
      });
      return new Response(response.body, { status: response.statusCode });
    },
  };
  try {
    await runCli(["status", "--config", configFile], dependencies);
    expect(output.join("")).toContain(call.call_id);
    await runCli(["pause", "--config", configFile], dependencies);
    expect(store.isPaused(false)).toBe(true);
    const destination = join(root, "audit.html");
    await runCli(
      [
        "audit",
        "export",
        "--config",
        configFile,
        "--call",
        call.call_id,
        "--format",
        "html",
        "--out",
        destination,
      ],
      dependencies,
    );
    const html = readFileSync(destination, "utf8");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    await expect(
      runCli(
        [
          "audit",
          "export",
          "--config",
          configFile,
          "--call",
          call.call_id,
          "--format",
          "html",
          "--out",
          destination,
        ],
        dependencies,
      ),
    ).rejects.toThrow("destination_must_be_new");
  } finally {
    await app.close();
    store.close();
  }
});
it("requires a stable explicit call key and passes the original body unchanged", async () => {
  const args = [
    "call",
    "--config",
    configFile,
    "--target",
    "owner",
    "--context-ref",
    "task",
    "--correlation-ref",
    "delivery",
    "--expires-at",
    "2026-09-17T10:00:00Z",
  ];
  await expect(runCli(args, { write: () => {} })).rejects.toThrow(
    "missing_key",
  );
  let calls = 0;
  await runCli([...args, "--key", "stable-key"], {
    write: () => {},
    fetch: async (_url, init) => {
      calls++;
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(
        "stable-key",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        target_id: "owner",
        context_ref: "task",
        correlation_ref: "delivery",
        expires_at: "2026-09-17T10:00:00Z",
      });
      return Response.json({ call_id: "example" });
    },
  });
  expect(calls).toBe(1);
});
it("excludes offline mutations while the service lock is held", async () => {
  const release = acquireProcessLock(join(directory, "data"));
  try {
    await expect(
      runCli(["cleanup", "--config", configFile], { write: () => {} }),
    ).rejects.toThrow("already_running");
  } finally {
    release();
  }
  await runCli(["cleanup", "--config", configFile], { write: () => {} });
});
it("persists recovery pause before runtime initialization and releases locks on failure", async () => {
  const database = join(directory, "data", "voxdock.sqlite");
  let store = new CallStore(database);
  const call = store.createCall(
    "backend",
    "key",
    {
      target_id: "owner",
      context_ref: "context",
      correlation_ref: "task",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    },
    { enabled: true, allowedTargets: new Set(["owner"]), maxTtlSeconds: 300 },
  ).call;
  store.transition(call.call_id, "dialing");
  store.close();
  await expect(
    startService(configFile, async ({ store }) => {
      expect(store.isPaused(false)).toBe(true);
      expect(store.getCall(call.call_id).state).toBe("uncertain");
      throw new Error("simulated runtime startup failure");
    }),
  ).rejects.toThrow("service_start_failed");
  store = new CallStore(database);
  expect(store.isPaused(false)).toBe(true);
  store.close();
  const release = acquireProcessLock(join(directory, "data"));
  release();
  await expect(
    runCli(["reconcile", call.call_id, "--config", configFile], {
      write: () => {},
    }),
  ).rejects.toThrow("confirm_ended_required");
  await runCli(
    ["reconcile", call.call_id, "--confirm-ended", "--config", configFile],
    { write: () => {} },
  );
  store = new CallStore(database);
  expect(store.getCall(call.call_id).reason).toBe("operator_confirmed_ended");
  expect(store.isPaused(false)).toBe(true);
  store.close();
  await expect(
    runCli(["resume", "--config", configFile], { write: () => {} }),
  ).rejects.toThrow("calling_disabled");
});

it("exports an allowlisted redacted summary in JSON and HTML while preserving private exports", async () => {
  const privateValue = "PRIVATE_PAYLOAD_MARKER";
  const call = {
    state: "ended",
    revision: 4,
    audio_ready: false,
    live_ready: false,
    created_at: "2026-09-16T12:00:00Z",
    updated_at: "2026-09-16T12:01:00Z",
    expires_at: "2026-09-16T12:05:00Z",
    call_id: privateValue,
    target_id: privateValue,
    context_ref: privateValue,
    correlation_ref: privateValue,
    provider_call_ref: privateValue,
    reason: privateValue,
    extra: { deep: { credential: privateValue } },
  };
  const record = {
    schema_version: 1,
    call,
    events: [
      {
        event_id: privateValue,
        type: privateValue,
        call_seq: 4,
        occurred_at: call.updated_at,
        call,
      },
    ],
    delegations: [
      {
        delegation_id: privateValue,
        principal_ref: privateValue,
        context_revision: 2,
        occurred_at: call.created_at,
        completeness: "final",
        fragments: [{ text: privateValue, source: { nested: privateValue } }],
      },
    ],
    results: [
      {
        result_id: privateValue,
        business_ref: privateValue,
        spoken_summary: privateValue,
        evidence_urls: [privateValue],
        revision: 3,
        context_revision: 2,
        status: "completed",
      },
    ],
    transcripts: [{ text: privateValue, metadata: { deep: privateValue } }],
    transcript_availability: "available",
    usage: {
      seconds: 60,
      status: "settled",
      zone: privateValue,
      unknown: { privateValue },
    },
    unknown: [{ very: { deep: { privateValue } } }],
  };
  const dependencies = {
    write: () => {},
    fetch: async () => Response.json(record),
  };
  for (const format of ["json", "html"]) {
    const out = join(root, `redacted.${format}`);
    await runCli(
      [
        "audit",
        "export",
        "--config",
        configFile,
        "--call",
        "call-id",
        "--format",
        format,
        "--out",
        out,
        "--redact",
      ],
      dependencies,
    );
    const content = readFileSync(out, "utf8");
    expect(content).not.toContain(privateValue);
    expect(content).not.toContain("spoken_summary");
    expect(content).not.toContain("target_id");
    if (format === "json")
      expect(JSON.parse(content)).toMatchObject({
        redacted: true,
        call: {
          state: "ended",
          revision: 4,
          updated_at: "2026-09-16T12:01:00.000Z",
        },
        counts: { events: 1, delegations: 1, results: 1, transcripts: 1 },
        usage: { seconds: 60, status: "settled" },
      });
  }
  const raw = join(root, "private.json");
  await runCli(
    [
      "audit",
      "export",
      "--config",
      configFile,
      "--call",
      "call-id",
      "--format",
      "json",
      "--out",
      raw,
    ],
    dependencies,
  );
  expect(JSON.parse(readFileSync(raw, "utf8"))).toEqual(record);
  await expect(
    runCli(["status", "--config", configFile, "--redact"], dependencies),
  ).rejects.toThrow("invalid_arguments");
});
