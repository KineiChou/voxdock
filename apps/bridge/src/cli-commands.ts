import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { CallStore } from "@voxdock/core";
import { RefSchema, CallRequestSchema } from "@voxdock/contracts";
import { Value } from "@sinclair/typebox/value";
import { controlRequest, renderAudit, redactAudit } from "./cli-api.js";
import {
  CliError,
  controlToken,
  initDirectory,
  loadConfig,
  writeExport,
} from "./cli-files.js";
import { doctor } from "./cli-doctor.js";
import { acquireProcessLock } from "./cli-lock.js";
import { startService, type RuntimeFactory } from "./cli-service.js";
const help = `VoxDock commands:
  init DIRECTORY
  doctor [--online]
  serve
  status [CALL_ID]
  targets
  call --target ID --context-ref REF --correlation-ref REF --key KEY --expires-at UTC_ISO
  end CALL_ID
  pause
  resume
  reconcile CALL_ID --confirm-ended
  audit export --call ID --format json|html --out NEW_FILE [--redact]
  cleanup
All commands except init accept --config FILE (default ./voxdock.config.json).
Resume, reconcile and cleanup require the service to be stopped.
`;
function argumentsOf(args: string[]) {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (name === "online" || name === "confirm-ended" || name === "redact") {
        flags.add(name);
        continue;
      }
      const value = args[++index];
      if (!value || value.startsWith("--") || name in values)
        throw new CliError("invalid_arguments");
      values[name] = value;
    } else positionals.push(arg);
  }
  return { values, flags, positionals };
}
function required(values: Record<string, string>, name: string): string {
  const value = values[name];
  if (!value) throw new CliError(`missing_${name.replace(/-/g, "_")}`);
  return value;
}
function ref(value: string | undefined): string {
  if (!Value.Check(RefSchema, value)) throw new CliError("invalid_reference");
  return value;
}
export interface CliDependencies {
  write?: (value: string) => void;
  fetch?: typeof fetch;
  runtimeFactory?: RuntimeFactory;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
}
export async function runCli(
  args: string[],
  dependencies: CliDependencies = {},
): Promise<{ close: () => Promise<void> } | undefined> {
  const write =
    dependencies.write ?? ((value) => process.stdout.write(value + "\n"));
  if (args.length === 1 && args[0] === "--help") {
    write(help);
    return;
  }
  const { values, flags, positionals } = argumentsOf(args);
  const command = positionals[0];
  if (!command || command === "help") {
    write(help);
    return;
  }
  const allowed: Record<string, string[]> = {
    init: [],
    doctor: ["config"],
    serve: ["config"],
    status: ["config"],
    targets: ["config"],
    call: [
      "config",
      "target",
      "context-ref",
      "correlation-ref",
      "key",
      "expires-at",
    ],
    end: ["config"],
    pause: ["config"],
    resume: ["config"],
    reconcile: ["config"],
    audit: ["config", "call", "format", "out"],
    cleanup: ["config"],
  };
  if (
    !allowed[command] ||
    Object.keys(values).some((key) => !allowed[command]!.includes(key)) ||
    [...flags].some((flag) =>
      flag === "online"
        ? command !== "doctor"
        : flag === "redact"
          ? command !== "audit"
          : command !== "reconcile",
    )
  )
    throw new CliError("invalid_arguments");
  const expected =
    command === "init" ||
    command === "end" ||
    command === "reconcile" ||
    command === "audit"
      ? 2
      : 1;
  if (positionals.length > expected + (command === "status" ? 1 : 0))
    throw new CliError("invalid_arguments");
  if (command === "init") {
    if (!positionals[1]) throw new CliError("directory_required");
    write(
      JSON.stringify({
        config: initDirectory(positionals[1]),
        calling_enabled: false,
      }),
    );
    return;
  }
  const filename = values.config ?? "./voxdock.config.json";
  if (command === "serve") {
    const service = await startService(filename, dependencies.runtimeFactory);
    write(JSON.stringify({ listening: service.address }));
    return service;
  }
  const { config, directory } = loadConfig(filename);
  const output = (value: unknown) => write(JSON.stringify(value, null, 2));
  const request = (
    path: string,
    options: Parameters<typeof controlRequest>[3] = {},
  ) =>
    controlRequest(config, controlToken(config, directory), path, {
      ...options,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
  if (command === "doctor") {
    const checks = doctor(config, directory, dependencies.environment);
    output({
      checks,
      ...(flags.has("online")
        ? { capabilities: await request("/v1/capabilities") }
        : {}),
    });
    if (checks.some((check) => check.status === "fail"))
      throw new CliError("doctor_checks_failed");
    return;
  }
  if (command === "status") {
    if (positionals[1])
      output(
        await request(`/v1/calls/${encodeURIComponent(ref(positionals[1]))}`),
      );
    else {
      const [capabilities, calls] = await Promise.all([
        request("/v1/capabilities"),
        request("/v1/calls"),
      ]);
      output({ capabilities, ...(calls as { calls: unknown }) });
    }
    return;
  }
  if (command === "targets") {
    output(await request("/v1/targets"));
    return;
  }
  if (command === "call") {
    const body = {
      target_id: required(values, "target"),
      context_ref: required(values, "context-ref"),
      correlation_ref: required(values, "correlation-ref"),
      expires_at: required(values, "expires-at"),
    };
    if (!Value.Check(CallRequestSchema, body))
      throw new CliError("invalid_call_request");
    const key = required(values, "key");
    if (!/^[\x21-\x7e]{1,200}$/.test(key))
      throw new CliError("invalid_idempotency_key");
    output(await request("/v1/calls", { method: "POST", body, key }));
    return;
  }
  if (command === "end") {
    output(
      await request(
        `/v1/calls/${encodeURIComponent(ref(positionals[1]))}/end`,
        { method: "POST" },
      ),
    );
    return;
  }
  if (command === "pause") {
    output(await request("/v1/control/pause", { method: "POST" }));
    return;
  }
  if (command === "audit") {
    if (positionals[1] !== "export") throw new CliError("invalid_arguments");
    const format = required(values, "format");
    if (format !== "json" && format !== "html")
      throw new CliError("invalid_format");
    const record = await request(
      `/v1/calls/${encodeURIComponent(ref(required(values, "call")))}/record`,
    );
    const exported = flags.has("redact") ? redactAudit(record) : record;
    writeExport(
      required(values, "out"),
      format === "html"
        ? renderAudit(exported)
        : JSON.stringify(exported, null, 2) + "\n",
    );
    output({ exported: true, format });
    return;
  }
  const data = resolve(directory, config.service.data_dir);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const release = acquireProcessLock(data);
  let store: CallStore | undefined;
  try {
    store = new CallStore(resolve(data, "voxdock.sqlite"), {
      persistTranscripts: config.records.transcript_retention_days > 0,
    });
    if (command === "resume") {
      if (!config.calling.enabled)
        throw new CliError("calling_disabled_in_configuration");
      if (store.listCalls().some((call) => call.state !== "ended"))
        throw new CliError("reconciliation_required");
      store.setPaused(false);
      output({ paused: false });
      return;
    }
    if (command === "reconcile") {
      if (!flags.has("confirm-ended"))
        throw new CliError("confirm_ended_required");
      const call = store.getCall(ref(positionals[1]));
      if (call.state === "ended") {
        output(call);
        return;
      }
      store.setPaused(true);
      output(
        store.transition(call.call_id, "ended", {
          reason: "operator_confirmed_ended",
        }),
      );
      return;
    }
    if (command === "cleanup") {
      const now = (dependencies.now ?? (() => new Date()))();
      store.prune({
        metadataBefore: new Date(
          now.getTime() - config.records.metadata_retention_days * 86400000,
        ).toISOString(),
        transcriptsBefore: new Date(
          now.getTime() - config.records.transcript_retention_days * 86400000,
        ).toISOString(),
      });
      output({ cleanup_completed: true });
      return;
    }
    throw new CliError("unknown_command");
  } finally {
    store?.close();
    release();
  }
}
