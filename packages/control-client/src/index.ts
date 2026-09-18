import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CallRequest, CallStatus } from "@voxdock/contracts";

export const ref = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)));
export const callInput = z.strictObject({
  target_id: ref,
  context_ref: ref,
  correlation_ref: ref,
  expires_at: timestamp,
  idempotency_key: z.string().regex(/^[\x21-\x7e]{1,200}$/),
});
export const callIdInput = z.strictObject({ call_id: ref });
const target = z.object({
  id: ref,
  channel: z.enum(["telegram", "whatsapp"]),
  enabled: z.boolean(),
});
const status = z
  .object({
    call_id: ref,
    target_id: ref,
    direction: z.enum(["inbound", "outbound"]),
    correlation_ref: ref,
    context_ref: ref,
    state: z.enum([
      "requested",
      "dialing",
      "ringing",
      "connected",
      "ending",
      "ended",
      "uncertain",
    ]),
    revision: z.number().int().positive(),
    audio_ready: z.boolean(),
    live_ready: z.boolean(),
    created_at: timestamp,
    updated_at: timestamp,
    expires_at: timestamp,
    reason: z.string().max(200).optional(),
    provider_call_ref: ref.optional(),
  })
  .transform(
    ({ reason, provider_call_ref, ...call }): CallStatus => ({
      ...call,
      ...(reason === undefined ? {} : { reason }),
      ...(provider_call_ref === undefined ? {} : { provider_call_ref }),
    }),
  );
const capabilities = z.object({
  calling_enabled: z.boolean(),
  server_time: timestamp.optional(),
  max_request_ttl_seconds: z.number().int().positive().optional(),
});
export type ControlErrorCode =
  | "invalid_configuration"
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rejected"
  | "unavailable"
  | "invalid_response"
  | "outcome_unknown";
export class ControlError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    readonly status?: number,
  ) {
    super(code);
    this.name = "ControlError";
  }
}
export type CallInput = z.infer<typeof callInput>;
export class ControlClient {
  private readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 15000,
  ) {
    try {
      const url = new URL(baseUrl);
      const loopback =
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]";
      if (
        !["https:", "http:"].includes(url.protocol) ||
        (url.protocol === "http:" && !loopback) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.pathname !== "/" && url.pathname !== "") ||
        !/^[\x21-\x7e]{1,4096}$/.test(token) ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 60000
      )
        throw new Error();
      this.baseUrl = url.origin;
    } catch {
      throw new ControlError("invalid_configuration");
    }
  }
  async listTargets() {
    const targets = await this.request("/v1/targets", z.array(target));
    const { server_time, ...caps } = await this.request("/v1/capabilities", capabilities);
    return { current_time: server_time ?? new Date().toISOString(), targets, ...caps };
  }
  async createCall(input: CallInput): Promise<CallStatus> {
    const parsed = callInput.safeParse(input);
    if (!parsed.success) throw new ControlError("invalid_input");
    const { idempotency_key, ...body } = parsed.data;
    return this.request("/v1/calls", status, {
      method: "POST",
      body: JSON.stringify(body satisfies CallRequest),
      headers: { "idempotency-key": idempotency_key },
    });
  }
  async getCall(callId: string): Promise<CallStatus> {
    return this.request(`/v1/calls/${this.callId(callId)}`, status);
  }
  async endCall(callId: string): Promise<CallStatus> {
    return this.request(`/v1/calls/${this.callId(callId)}/end`, status, {
      method: "POST",
    });
  }
  private callId(value: string) {
    if (!ref.safeParse(value).success) throw new ControlError("invalid_input");
    return encodeURIComponent(value);
  }
  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
  ): Promise<T> {
    const mutation = init.method === "POST";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.baseUrl + path, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        const code: ControlErrorCode =
          response.status === 401
            ? "unauthorized"
            : response.status === 403
              ? "forbidden"
              : response.status === 404
                ? "not_found"
                : response.status === 409
                  ? "conflict"
                  : response.status >= 500
                    ? mutation
                      ? "outcome_unknown"
                      : "unavailable"
                    : "rejected";
        throw new ControlError(code, response.status);
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new ControlError(
          mutation ? "outcome_unknown" : "invalid_response",
        );
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) {
          await reader.cancel();
          throw new ControlError(
            mutation ? "outcome_unknown" : "invalid_response",
          );
        }
        chunks.push(value);
      }
      const parsed = schema.safeParse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (!parsed.success)
        throw new ControlError(
          mutation ? "outcome_unknown" : "invalid_response",
        );
      return parsed.data;
    } catch (error) {
      if (error instanceof ControlError) throw error;
      throw new ControlError(mutation ? "outcome_unknown" : "unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
export async function clientFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
) {
  try {
    const baseUrl = env.VOXDOCK_BASE_URL;
    const tokenPath = env.VOXDOCK_AGENT_TOKEN_FILE;
    if (!baseUrl || !tokenPath) throw new Error();
    const token = (await readFile(tokenPath, "utf8")).trim();
    return new ControlClient(
      baseUrl,
      token,
      env.VOXDOCK_REQUEST_TIMEOUT_MS === undefined
        ? 15000
        : Number(env.VOXDOCK_REQUEST_TIMEOUT_MS),
    );
  } catch {
    throw new ControlError("invalid_configuration");
  }
}
