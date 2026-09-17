import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = join(repository, "apps/bridge/src/cli.ts");
const children = new Set<ChildProcess>();
const outputs: string[] = [];
let temporary: string | undefined;
let token = "";
const consolePassword = "local-smoke-console-password";
function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function launch(args: string[]) {
  const env = Object.fromEntries(
    ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "LANG"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]],
    ),
  );
  const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: repository,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  let finished = false;
  const capture = (kind: "stdout" | "stderr", chunk: Buffer) => {
    if (kind === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
    if (stdout.length + stderr.length > 65536) child.kill("SIGKILL");
  };
  child.stdout!.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr!.on("data", (chunk: Buffer) => capture("stderr", chunk));
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolveDone, reject) => {
    child.once("error", () => {
      finished = true;
      children.delete(child);
      reject(new Error("child_spawn_failed"));
    });
    child.once("close", (code, signal) => {
      finished = true;
      children.delete(child);
      outputs.push(stdout, stderr);
      resolveDone({ code, signal, stdout, stderr });
    });
  });
  void done.catch(() => {});
  return { child, done, isFinished: () => finished };
}
async function command(args: string[], expectedCode = 0) {
  const running = launch(args);
  try {
    const result = await bounded(running.done, 10000, "command_timeout");
    check(
      result.code === expectedCode && result.signal === null,
      "command_exit_mismatch",
    );
    return result;
  } catch (error) {
    running.child.kill("SIGKILL");
    await running.done.catch(() => {});
    throw error;
  }
}
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolveReady, reject) => {
    server.once("listening", resolveReady);
    server.once("error", () => reject(new Error("loopback_bind_failed")));
  });
  const address = server.address();
  check(address && typeof address === "object", "port_allocation_failed");
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}
async function request(url: string, authenticated = false) {
  return fetch(url, {
    headers: authenticated ? { authorization: `Bearer ${token}` } : {},
    redirect: "error",
    signal: AbortSignal.timeout(1000),
  });
}
async function start(configFile: string, origin: string) {
  const running = launch(["serve", "--config", configFile]);
  const deadline = Date.now() + 10000;
  try {
    while (Date.now() < deadline) {
      check(!running.isFinished(), "service_exited_during_startup");
      try {
        const response = await request(`${origin}/healthz`);
        if (response.status === 200) {
          check(
            ((await response.json()) as { status: string }).status === "ok",
            "health_body_invalid",
          );
          return running;
        }
      } catch (error) {
        if (error instanceof Error && error.message === "health_body_invalid")
          throw error;
      }
      await delay(50);
    }
    throw new Error("service_startup_timeout");
  } catch (error) {
    running.child.kill("SIGKILL");
    await running.done.catch(() => {});
    throw error;
  }
}
async function stop(running: ReturnType<typeof launch>) {
  running.child.kill("SIGTERM");
  const result = await bounded(running.done, 10000, "service_shutdown_timeout");
  check(result.code === 0 && result.signal === null, "service_shutdown_failed");
}

try {
  check(Number(process.versions.node.split(".")[0]) === 24, "node_24_required");
  temporary = await mkdtemp(join(tmpdir(), "voxdock-control-smoke-"));
  const instance = join(temporary, "instance");
  await command(["init", instance]);
  const configFile = join(instance, "voxdock.config.json");
  const config = JSON.parse(await readFile(configFile, "utf8")) as {
    service: { listen: string };
    calling: { enabled: boolean };
    channels: Record<string, { enabled: boolean }>;
    console: { enabled: boolean; public_origin?: string; password_hash_file?: string };
  };
  check(
    !config.calling.enabled &&
      Object.values(config.channels).every((channel) => !channel.enabled),
    "initialization_enabled_calling",
  );
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  config.service.listen = `127.0.0.1:${port}`;
  const passwordFile = join(instance, "password-input");
  await writeFile(passwordFile, consolePassword + "\n", { mode: 0o600 });
  await command(["console", "password", "--password-file", passwordFile, "--out", join(instance, "admin.hash")]);
  await rm(passwordFile);
  config.console = { enabled: true, public_origin: origin, password_hash_file: "./admin.hash" };
  await writeFile(configFile, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  token = (await readFile(join(instance, "control.token"), "utf8")).trim();
  const doctor = JSON.parse(
    (await command(["doctor", "--config", configFile])).stdout,
  ) as { checks: { name: string; status: string }[] };
  check(
    doctor.checks.every((check) => check.status !== "fail"),
    "offline_doctor_failed",
  );
  const service = await start(configFile, origin);
  const page = await request(`${origin}/console/`);
  check(page.status === 200 && (await page.text()).includes('<div id="root">'), "console_assets_missing");
  check((await request(`${origin}/admin/v1/overview`)).status === 401, "console_authentication_missing");
  const login = await fetch(`${origin}/admin/v1/session`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password: consolePassword }), signal: AbortSignal.timeout(3000),
  });
  check(login.status === 200, "console_login_failed");
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  const session = await login.json() as { csrf_token: string };
  check(cookie && session.csrf_token, "console_session_missing");
  const overview = await fetch(`${origin}/admin/v1/overview?days=7`, {
    headers: { cookie }, signal: AbortSignal.timeout(3000),
  });
  check(overview.status === 200 && (await overview.json() as { totals: { calls: number } }).totals.calls === 0, "console_overview_failed");
  const logout = await fetch(`${origin}/admin/v1/session`, {
    method: "DELETE", headers: { cookie, origin, "x-csrf-token": session.csrf_token }, signal: AbortSignal.timeout(3000),
  });
  check(logout.status === 204, "console_logout_failed");
  const replay = await fetch(`${origin}/admin/v1/session`, { headers: { cookie }, signal: AbortSignal.timeout(3000) });
  check(replay.status === 401, "console_logout_replay_allowed");
  check(
    (await request(`${origin}/v1/capabilities`)).status === 401,
    "unauthorized_api_allowed",
  );
  const status = JSON.parse(
    (await command(["status", "--config", configFile])).stdout,
  ) as {
    capabilities: {
      calling_enabled: boolean;
      channels: Record<string, { enabled: boolean; ready: boolean }>;
    };
    calls: unknown[];
  };
  check(
    !status.capabilities.calling_enabled &&
      Object.values(status.capabilities.channels).every(
        (channel) => !channel.enabled && !channel.ready,
      ) &&
      status.calls.length === 0,
    "disabled_runtime_status_invalid",
  );
  const duplicate = await command(["serve", "--config", configFile], 1);
  check(
    duplicate.stderr.includes("already_running_or_data_unavailable"),
    "duplicate_process_lock_not_reported",
  );
  check(
    (await request(`${origin}/healthz`)).status === 200,
    "duplicate_start_disturbed_service",
  );
  const pause = JSON.parse(
    (await command(["pause", "--config", configFile])).stdout,
  ) as { paused: boolean };
  check(pause.paused === true, "pause_failed");
  await stop(service);
  const restarted = await start(configFile, origin);
  const restartedStatus = await request(`${origin}/v1/capabilities`, true);
  check(restartedStatus.status === 200, "restart_authenticated_api_failed");
  check(
    !((await restartedStatus.json()) as { calling_enabled: boolean })
      .calling_enabled,
    "restart_enabled_calling",
  );
  await stop(restarted);
  check(
    outputs.every((output) => !output.includes(token) && !output.includes(consolePassword)),
    "secret_present_in_child_output",
  );
  process.stdout.write(
    "Control smoke passed: init, offline doctor, disabled runtime, console assets/login/overview/logout, bearer authentication, process lock, pause, shutdown and restart.\n",
  );
} catch (error) {
  const label =
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "unexpected_smoke_failure";
  process.stderr.write(`Control smoke failed: ${label}\n`);
  process.exitCode = 1;
} finally {
  const closed = [...children].map(
    (child) =>
      new Promise<void>((resolveClosed) =>
        child.once("close", () => resolveClosed()),
      ),
  );
  for (const child of children) child.kill("SIGKILL");
  await bounded(Promise.all(closed), 2000, "cleanup_timeout").catch(() => {
    process.exitCode = 1;
  });
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
