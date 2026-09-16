import type { BridgeConfig } from "@voxdock/config";
import { CliError } from "./cli-files.js";
export async function controlRequest(
  config: BridgeConfig,
  token: string,
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
    key?: string;
    fetch?: typeof fetch;
  } = {},
): Promise<unknown> {
  const listen = config.service.listen
    .replace(/^0\.0\.0\.0:/, "127.0.0.1:")
    .replace(/^\[::\]:/, "[::1]:");
  const url = new URL(`http://${listen}${path}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    if (options.key) headers["idempotency-key"] = options.key;
    const response = await (options.fetch ?? fetch)(url, {
      method: options.method ?? "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (!response.body) throw new CliError("empty_control_response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const value = await reader.read();
        if (value.done) break;
        bytes += value.value.byteLength;
        if (bytes > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new CliError("control_response_too_large");
        }
        chunks.push(value.value);
      }
    } finally {
      reader.releaseLock();
    }
    let result: unknown;
    try {
      result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new CliError("invalid_control_response");
    }
    if (!response.ok) {
      const code =
        result &&
        typeof result === "object" &&
        "error" in result &&
        typeof result.error === "string" &&
        /^[a-z_]{1,80}$/.test(result.error)
          ? result.error
          : "control_request_failed";
      throw new CliError(code);
    }
    return result;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      controller.signal.aborted
        ? "control_timeout_outcome_unknown"
        : "control_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}
export function renderAudit(record: unknown): string {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]!,
    );
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>VoxDock call record</title><style>body{font:16px/1.5 system-ui;max-width:1000px;margin:40px auto;padding:0 24px;color:#17212b}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f8;padding:24px;border-radius:12px}</style><body><h1>VoxDock call record</h1><pre>${escape(JSON.stringify(record, null, 2))}</pre></body></html>\n`;
}
