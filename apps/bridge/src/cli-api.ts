import type { BridgeConfig } from "@voxdock/config";
import { CliError } from "./cli-files.js";
export async function controlRequest(
  config: BridgeConfig,
  token: string,
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT";
    timeoutMs?: number;
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
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
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

/** Build a shareable summary from approved fields only; never copy source objects. */
export function redactAudit(input: unknown) {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const items = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : [];
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const revision = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const known = (value: unknown, choices: readonly string[]): string | null =>
    typeof value === "string" && choices.includes(value) ? value : null;
  const timestamp = (value: unknown): string | null => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    )
      return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  const callSummary = (value: unknown) => {
    const call = object(value);
    return {
      state: known(call.state, [
        "requested",
        "dialing",
        "ringing",
        "connected",
        "ending",
        "ended",
        "uncertain",
      ]),
      revision: revision(call.revision),
      audio_ready:
        typeof call.audio_ready === "boolean" ? call.audio_ready : null,
      live_ready: typeof call.live_ready === "boolean" ? call.live_ready : null,
      created_at: timestamp(call.created_at),
      updated_at: timestamp(call.updated_at),
      expires_at: timestamp(call.expires_at),
    };
  };
  const record = object(input);
  const usage = object(record.usage);
  return {
    schema_version: 1,
    redacted: true,
    call: callSummary(record.call),
    counts: {
      events: items(record.events).length,
      delegations: items(record.delegations).length,
      results: items(record.results).length,
      transcripts: items(record.transcripts).length,
    },
    transcript_availability: known(record.transcript_availability, [
      "available",
      "empty",
      "disabled",
      "expired",
    ]),
    events: items(record.events).map((value) => {
      const event = object(value);
      return {
        call_seq: revision(event.call_seq),
        occurred_at: timestamp(event.occurred_at),
        call: callSummary(event.call),
      };
    }),
    delegations: items(record.delegations).map((value) => {
      const delegation = object(value);
      return {
        context_revision: revision(delegation.context_revision),
        occurred_at: timestamp(delegation.occurred_at),
        completeness: known(delegation.completeness, ["partial", "final"]),
        fragments_count: items(delegation.fragments).length,
      };
    }),
    results: items(record.results).map((value) => {
      const result = object(value);
      return {
        revision: revision(result.revision),
        context_revision: revision(result.context_revision),
        status: known(result.status, [
          "accepted",
          "working",
          "completed",
          "failed",
          "needs_clarification",
        ]),
      };
    }),
    usage:
      record.usage === undefined
        ? null
        : {
            seconds: number(usage.seconds),
            status: known(usage.status, ["reserved", "incomplete", "settled"]),
          },
  };
}
