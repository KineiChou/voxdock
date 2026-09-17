import { existsSync, mkdirSync } from "node:fs";
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
  readPrivateText,
} from "./cli-files.js";
import { hashConsolePassword } from "./console-password.js";
import { openConsoleAccount } from './console-account.js';
import { ConfigurationStore } from './configuration-store.js';
import { doctor } from "./cli-doctor.js";
import { acquireProcessLock } from "./cli-lock.js";
import { startService, type RuntimeFactory } from "./cli-service.js";
const help = `VoxDock commands:
  init DIRECTORY
  doctor [--online]
  serve
  status [CALL_ID]
  targets
  overview [--days 1|7|30]
  calls [--limit N --cursor CURSOR --channel CHANNEL --direction DIRECTION --state STATE --from UTC_ISO --to UTC_ISO]
  connections
  settings [options]
  configuration [--file PRIVATE_JSON]
  connection connect|disconnect --channel telegram|whatsapp [--input-file PRIVATE_JSON]
  connection unlink --channel whatsapp
  connection status|code|password|cancel --flow ID [--input-file PRIVATE_JSON]
  connection refresh --flow ID
  connection setup --channel whatsapp
  connection target --channel telegram --input-file PRIVATE_JSON
  target-pair start --method message|call
  target-pair status|cancel --flow ID
  target-pair confirm --flow ID --candidate ID
  console password --password-file PRIVATE_FILE --out NEW_HASH_FILE
  console recover --config FILE [--username NAME --password-file PRIVATE_FILE --allow-remote true|false]
  call --target ID --context-ref REF --correlation-ref REF --key KEY --expires-at UTC_ISO
  end CALL_ID
  pause
  resume [--online]
  reconcile CALL_ID --confirm-ended
  audit export --call ID --format json|html --out NEW_FILE [--redact]
  cleanup
All commands except init and console password accept --config FILE (default ./voxdock.config.json).
Offline resume, reconcile and cleanup require the service to be stopped.
Console recovery also requires the service to be stopped. Configuration changes temporarily block new calls.
Console password writes a new private hash file; configure its reference and restart to apply it.
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
    overview: ["config", "days"],
    calls: ["config", "limit", "cursor", "channel", "direction", "state", "from", "to"],
    connections: ["config"],
    settings: ["config"],
    configuration: ["config", "file"],
    connection: ["config", "channel", "flow", "input-file"],
    'target-pair': ['config', 'method', 'flow', 'candidate'],
    console: ["config", "username", "password-file", "out", "allow-remote"],
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
        ? command !== "doctor" && command !== "resume"
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
    command === "audit" ||
    command === "console" || command === 'connection' || command === 'target-pair' || command === 'settings'
      ? 2
      : 1;
  if (positionals.length > expected + (command === "status" ? 1 : 0))
    throw new CliError("invalid_arguments");
  if (command === 'settings' && positionals[1] !== undefined && positionals[1] !== 'options')
    throw new CliError('invalid_arguments');
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
  if (command === "console") {
    if (positionals[1] === 'recover') {
      if (values.out || (values['allow-remote'] !== undefined && !['true', 'false'].includes(values['allow-remote']))) throw new CliError('invalid_arguments');
      if (!values.username && !values['password-file'] && values['allow-remote'] === undefined) throw new CliError('recovery_change_required');
      const { config, directory } = loadConfig(values.config ?? './voxdock.config.json');
      const data = resolve(directory, config.service.data_dir);
      mkdirSync(data, { recursive: true, mode: 0o700 });
      const release = acquireProcessLock(data);
      try {
        const account = await openConsoleAccount({ dataDirectory: data, ...(config.console.password_hash_file && !existsSync(resolve(data, 'console-account.json')) ? { legacyPasswordHash: readPrivateText(resolve(directory, config.console.password_hash_file)) } : {}) });
        write(JSON.stringify(await account.recover({ ...(values.username ? { username: values.username } : {}), ...(values['password-file'] ? { new_password: readPrivateText(values['password-file']) } : {}), ...(values['allow-remote'] !== undefined ? { allow_remote_management: values['allow-remote'] === 'true' } : {}) })));
      } finally { release(); }
      return;
    }
    if (positionals[1] !== "password") throw new CliError("invalid_arguments");
    const password = readPrivateText(required(values, "password-file"));
    if (password.length < 12 || password.length > 256) throw new CliError("invalid_console_password_length");
    const digest = await hashConsolePassword(password);
    writeExport(required(values, "out"), digest + "\n");
    write(JSON.stringify({ password_hash_written: true }));
    return;
  }
  const filename = values.config ?? "./voxdock.config.json";
  if (command === "serve") {
    const service = await startService(filename, dependencies.runtimeFactory);
    write(JSON.stringify({ listening: service.address }));
    return service;
  }
  const { config: baseline, directory } = loadConfig(filename);
  const config = new ConfigurationStore(baseline, directory, resolve(directory, baseline.service.data_dir)).effective();
  const output = (value: unknown) => write(JSON.stringify(value, null, 2));
  const request = (
    path: string,
    options: Parameters<typeof controlRequest>[3] = {},
  ) =>
    controlRequest(config, controlToken(config, directory), path, {
      ...options,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
  if (command === 'configuration') {
    output(await request('/v1/console/settings/configuration', values.file ? { method: 'PUT', body: JSON.parse(readPrivateText(values.file)), timeoutMs: 60000 } : {}));
    return;
  }
  if (command === 'connection') {
    const action = positionals[1];
    if (action === 'refresh' && (values.channel || values['input-file'])) throw new CliError('invalid_arguments');
    const body: unknown = values['input-file'] ? JSON.parse(readPrivateText(values['input-file'])) : {};
    if (action === 'setup' || action === 'target') {
      if (values.flow || values.channel !== (action === 'setup' ? 'whatsapp' : 'telegram') || (action === 'setup' && values['input-file']) || (action === 'target' && !values['input-file'])) throw new CliError('invalid_arguments');
      output(await request(`/v1/console/connections/${values.channel}/${action}`, action === 'setup' ? {} : { method: 'POST', body, timeoutMs: 45000 }));
    } else if (action === 'connect' || action === 'disconnect' || action === 'unlink') {
      const channel = required(values, 'channel');
      if (!['telegram', 'whatsapp'].includes(channel) || values.flow) throw new CliError('invalid_arguments');
      if (action === 'unlink' && (channel !== 'whatsapp' || values['input-file'])) throw new CliError('invalid_arguments');
      output(await request(`/v1/console/connections/${channel}/${action === 'connect' && channel === 'telegram' ? 'login' : action}`, { method: 'POST', body, timeoutMs: 45000 }));
    } else if (action && ['status', 'code', 'password', 'cancel', 'refresh'].includes(action)) {
      if (values.channel) throw new CliError('invalid_arguments');
      const flow = ref(required(values, 'flow'));
      output(await request(`/v1/console/connections/flows/${encodeURIComponent(flow)}${action === 'status' ? '' : '/' + action}`, action === 'status' ? {} : { method: 'POST', body, timeoutMs: 45000 }));
    } else throw new CliError('invalid_arguments');
    return;
  }
  if (command === 'target-pair') {
    const action = positionals[1];
    const base = '/v1/console/connections/whatsapp/target-pairings';
    if (action === 'start') {
      if (!['message', 'call'].includes(values.method ?? '') || values.flow || values.candidate) throw new CliError('invalid_arguments');
      output(await request(base, { method: 'POST', body: { method: values.method }, timeoutMs: 45000 }));
    } else if (action && ['status', 'confirm', 'cancel'].includes(action)) {
      const flow = ref(required(values, 'flow'));
      if (values.method || (action !== 'confirm' && values.candidate)) throw new CliError('invalid_arguments');
      output(await request(`${base}/${encodeURIComponent(flow)}${action === 'status' ? '' : '/' + action}`, action === 'status' ? {} : {
        method: 'POST', body: action === 'confirm' ? { candidate_id: ref(required(values, 'candidate')) } : {}, timeoutMs: 45000,
      }));
    } else throw new CliError('invalid_arguments');
    return;
  }
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
  if (["overview", "calls", "connections", "settings"].includes(command)) {
    const query = new URLSearchParams(Object.entries(values).filter(([key]) => key !== "config"));
    const resource = command === 'settings' && positionals[1] === 'options' ? 'settings/options' : command;
    output(await request(`/v1/console/${resource}${query.size ? `?${query}` : ""}`));
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
  if (command === "resume" && flags.has("online")) {
    output(await request("/v1/console/control/resume", { method: "POST" }));
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
