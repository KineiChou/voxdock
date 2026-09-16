import { randomBytes } from "node:crypto";
import {
  openSync,
  readFileSync,
  fstatSync,
  closeSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parseConfig, type BridgeConfig } from "@voxdock/config";
export class CliError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CliError";
  }
}
export function readPrivateText(filename: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(filename, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536)
      throw new CliError("invalid_credential_file");
    const value = readFileSync(fd, "utf8").trim();
    if (!value) throw new CliError("empty_credential_file");
    return value;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("credential_file_unreadable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function loadConfig(filename: string): {
  config: BridgeConfig;
  directory: string;
  filename: string;
} {
  const absolute = resolve(filename);
  let fd: number | undefined;
  try {
    fd = openSync(absolute, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new CliError("invalid_config_file");
    return {
      config: parseConfig(JSON.parse(readFileSync(fd, "utf8"))),
      directory: dirname(absolute),
      filename: absolute,
    };
  } catch {
    throw new CliError("invalid_or_unreadable_configuration");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function initDirectory(directory: string): string {
  const destination = resolve(directory);
  try {
    mkdirSync(destination, { mode: 0o700 });
    mkdirSync(resolve(destination, "data"), { mode: 0o700 });
    writeFileSync(
      resolve(destination, "control.token"),
      randomBytes(32).toString("base64url") + "\n",
      { flag: "wx", mode: 0o600 },
    );
    const config = parseConfig({
      security: { control_token_file: "./control.token" },
      service: { data_dir: "./data" },
    });
    const filename = resolve(destination, "voxdock.config.json");
    writeFileSync(filename, JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    return filename;
  } catch {
    throw new CliError("initialization_failed_directory_must_be_new");
  }
}
export function controlToken(config: BridgeConfig, directory: string): string {
  if (!config.security.control_token_file)
    throw new CliError("control_token_required");
  const token = readPrivateText(
    resolve(directory, config.security.control_token_file),
  );
  if (token.length < 32 || /\s/.test(token))
    throw new CliError("invalid_control_token");
  return token;
}
export function writeExport(filename: string, content: string): void {
  try {
    writeFileSync(resolve(filename), content, { flag: "wx", mode: 0o600 });
  } catch {
    throw new CliError("export_failed_destination_must_be_new");
  }
}
