import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Channel, CallStatus, DelegationResult } from "@voxdock/contracts";
import type { BridgeConfig } from "@voxdock/config";
import { CallStore } from "@voxdock/core";
import { createBridgeServer } from "./server.js";
import { loadConfig, controlToken, readPrivateText, CliError } from "./cli-files.js";
import { isConsolePasswordHash } from "./console-password.js";
import { acquireProcessLock } from "./cli-lock.js";
import { openConsoleAccount } from './console-account.js';
import { ConfigurationStore } from './configuration-store.js';
import { RuntimeManager } from './runtime-manager.js';
import { createConnectionService, type ConnectionService } from './connection-service.js';
import { DomainError } from '@voxdock/core';
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
  const { config: baseline, directory } = loadConfig(filename);
  const token = controlToken(baseline, directory);
  const data = resolve(directory, baseline.service.data_dir);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const release = acquireProcessLock(data);
  let store: CallStore | undefined;
  let runtime: RuntimeManager | undefined;
  let connections: ConnectionService | undefined;
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
      if (connections) await bounded(() => connections!.close(), 15000);
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
    const passwordHash = baseline.console.enabled && baseline.console.password_hash_file && !existsSync(resolve(data, 'console-account.json'))
      ? readPrivateText(resolve(directory, baseline.console.password_hash_file)) : undefined;
    if (passwordHash && !isConsolePasswordHash(passwordHash)) throw new CliError('invalid_console_password_hash');
    const configuration = new ConfigurationStore(baseline, directory, data);
    configuration.prepareSessionDirectory();
    const config = configuration.effective();
    const account = config.console.enabled ? await openConsoleAccount({ dataDirectory: data, ...(passwordHash ? { legacyPasswordHash: passwordHash } : {}) }) : undefined;
    store = new CallStore(resolve(data, "voxdock.sqlite"), {
      persistTranscripts: config.records.transcript_retention_days > 0,
    });
    if (store.recover().length) store.setPaused(true);
    runtime = new RuntimeManager(config, store, directory, factory, configuration);
    await runtime.start();
    connections = createConnectionService({
      acquire: () => runtime!.acquire(),
      async getTelegramConfig() {
        const tg = config.channels.telegram;
        const apiId = tg.api_id ?? Number(tg.api_id_env ? process.env[tg.api_id_env] : undefined);
        if (!Number.isSafeInteger(apiId) || apiId <= 0 || !tg.api_hash_file || !tg.session_file) throw new DomainError('telegram_credentials_required', 409);
        return { apiId, apiHash: readPrivateText(resolve(directory, tg.api_hash_file)), sessionFile: resolve(directory, tg.session_file) };
      },
      async getWhatsAppConfig() {
        const wa = config.channels.whatsapp;
        if (!wa.endpoint || !wa.account_ref) throw new DomainError('whatsapp_service_required', 409);
        return { baseUrl: wa.endpoint, sessionId: wa.account_ref, clientId: `voxdock:${wa.account_ref}` };
      },
    });
    app = await createBridgeServer({
      config,
      store,
      controlToken: token,
      management: runtime,
      connections,
      get readyChannels() { return runtime!.readyChannels; },
      onCallCreated: (call) => runtime!.onCallCreated(call),
      onEnd: (call) => runtime!.onEnd(call),
      onResult: (result) => runtime!.onResult(result),
      ...(account ? { console: {
        account,
        trustedProxyAddresses: config.console.trusted_proxy_addresses,
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
