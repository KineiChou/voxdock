import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Channel, CallStatus, DelegationResult } from "@voxdock/contracts";
import type { BridgeConfig } from "@voxdock/config";
import { CallStore } from "@voxdock/core";
import { createBridgeServer } from "./server.js";
import { loadConfig, controlToken, readPrivateText, CliError } from "./cli-files.js";
import { isConsolePasswordHash } from "./console-password.js";
import { acquireProcessLock } from "./cli-lock.js";
export interface Runtime {
  readyChannels: ReadonlySet<Channel>;
  onCallCreated(call: CallStatus): Promise<void>;
  onEnd(call: CallStatus): Promise<void>;
  onResult(result: DelegationResult): Promise<void>;
  close(): Promise<void>;
}
export type RuntimeFactory = (options: {
  config: BridgeConfig;
  store: CallStore;
  configDirectory: string;
}) => Promise<Runtime>;
export async function defaultRuntimeFactory(
  options: Parameters<RuntimeFactory>[0],
): Promise<Runtime> {
  const name = "@voxdock/runtime";
  const module = (await import(name)) as { createRuntime: RuntimeFactory };
  return module.createRuntime(options);
}
async function bounded(
  action: () => Promise<unknown>,
  milliseconds = 5000,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new CliError("shutdown_timeout")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
export async function startService(
  filename: string,
  factory: RuntimeFactory = defaultRuntimeFactory,
) {
  const { config, directory } = loadConfig(filename);
  const token = controlToken(config, directory);
  const passwordHash = config.console.enabled
    ? readPrivateText(resolve(directory, config.console.password_hash_file!))
    : undefined;
  if (passwordHash && !isConsolePasswordHash(passwordHash)) throw new CliError("invalid_console_password_hash");
  const data = resolve(directory, config.service.data_dir);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const release = acquireProcessLock(data);
  let store: CallStore | undefined;
  let runtime: Runtime | undefined;
  let app: Awaited<ReturnType<typeof createBridgeServer>> | undefined;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    let failed = false;
    try {
      if (app) await bounded(() => app!.close());
    } catch {
      failed = true;
    }
    try {
      if (runtime) await bounded(() => runtime!.close(), 25000);
    } catch {
      failed = true;
    }
    try {
      store?.close();
    } catch {
      failed = true;
    } finally {
      release();
    }
    if (failed) throw new CliError("shutdown_incomplete");
  }
  try {
    store = new CallStore(resolve(data, "voxdock.sqlite"), {
      persistTranscripts: config.records.transcript_retention_days > 0,
    });
    if (store.recover().length) store.setPaused(true);
    runtime = await factory({ config, store, configDirectory: directory });
    app = await createBridgeServer({
      config,
      store,
      controlToken: token,
      readyChannels: runtime.readyChannels,
      onCallCreated: (call) => runtime!.onCallCreated(call),
      onEnd: (call) => runtime!.onEnd(call),
      onResult: (result) => runtime!.onResult(result),
      ...(passwordHash ? { console: {
        passwordHash,
        publicOrigin: config.console.public_origin!,
        assetsDirectory: fileURLToPath(new URL('../../console/dist', import.meta.url)),
      } } : {}),
    });
    const separator = config.service.listen.lastIndexOf(":");
    const host = config.service.listen
      .slice(0, separator)
      .replace(/^\[|\]$/g, "");
    const port = Number(config.service.listen.slice(separator + 1));
    const address = await app.listen({ host, port });
    return { address, close };
  } catch {
    try {
      await close();
    } catch {}
    throw new CliError("service_start_failed");
  }
}
