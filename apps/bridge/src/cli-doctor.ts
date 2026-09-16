import { accessSync, constants, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { BridgeConfig } from "@voxdock/config";
import { controlToken } from "./cli-files.js";
export interface Check {
  name: string;
  status: "pass" | "fail" | "unverified";
}
export function doctor(
  config: BridgeConfig,
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Check[] {
  const checks: Check[] = [
    { name: "configuration", status: "pass" },
    {
      name: "node_24",
      status:
        Number(process.versions.node.split(".")[0]) === 24 ? "pass" : "fail",
    },
  ];
  try {
    controlToken(config, directory);
    checks.push({ name: "control_token", status: "pass" });
  } catch {
    checks.push({ name: "control_token", status: "fail" });
  }
  function file(name: string, path: string | undefined) {
    try {
      if (!path) throw new Error();
      const resolved = resolve(directory, path);
      accessSync(resolved, constants.R_OK);
      if (
        !statSync(resolved).isFile() ||
        statSync(resolved).size === 0 ||
        (statSync(resolved).mode & 0o077) !== 0
      )
        throw new Error();
      checks.push({ name, status: "pass" });
    } catch {
      checks.push({ name, status: "fail" });
    }
  }
  if (config.channels.telegram.enabled) {
    const channel = config.channels.telegram;
    checks.push({
      name: "telegram_api_id",
      status: /^[1-9]\d*$/.test(environment[channel.api_id_env] ?? "")
        ? "pass"
        : "fail",
    });
    file("telegram_api_hash", channel.api_hash_file);
    file("telegram_session", channel.session_file);
    checks.push({
      name: "telegram_ffmpeg",
      status:
        spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 3000 })
          .status === 0
          ? "pass"
          : "fail",
    });
    checks.push({ name: "telegram_native_adapter", status: "unverified" });
  }
  if (config.channels.whatsapp.enabled) {
    file("whatsapp_media_token", config.channels.whatsapp.media_token_file);
    checks.push({ name: "whatsapp_media_bridge", status: "unverified" });
  }
  for (const target of config.targets.filter(
    (target) => target.enabled && config.channels[target.channel].enabled,
  ))
    checks.push({
      name: `target_${target.id}`,
      status: environment[target.peer_id_env] ? "pass" : "fail",
    });
  if (config.channels.telegram.enabled || config.channels.whatsapp.enabled) {
    file("live_api_key", config.live.api_key_file);
    file("backend_request_token", config.backend?.request_token_file);
    file("backend_event_signing_key", config.backend?.event_signing_key_file);
  }
  checks.push({ name: "native_call_and_live_readiness", status: "unverified" });
  return checks;
}
