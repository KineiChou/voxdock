import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  BackendContextSchema,
  DelegationResultSchema,
  type BackendContext,
  type CallStatus,
  type Delegation,
  type DelegationResult,
  type CallEvent,
} from "@voxdock/contracts";
import { signEvent } from "./auth.js";
const ContextResponseSchema = Type.Object(
  {
    call_id: Type.String(),
    context_ref: Type.String(),
    context: BackendContextSchema,
  },
  { additionalProperties: false },
);
export class BackendError extends Error {
  readonly acceptance = "unknown";
  constructor(public readonly code: string) {
    super(code);
    this.name = "BackendError";
  }
}
export interface BackendClientOptions {
  baseUrl: string;
  requestToken: string;
  eventSigningKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}
export class BackendClient {
  private readonly base: URL;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly timeout: number;
  constructor(private readonly options: BackendClientOptions) {
    this.base = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash
    )
      throw new Error("Invalid backend endpoint");
    if (!options.requestToken || !options.eventSigningKey)
      throw new Error("Backend authentication required");
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeout = options.timeoutMs ?? 3000;
    if (
      !Number.isFinite(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 30000
    )
      throw new Error("Invalid backend timeout");
  }
  async context(
    call: CallStatus,
    principalRef: string,
    phase: "before_dial" | "before_greeting",
  ): Promise<BackendContext> {
    const response = await this.request("/voice/v1/context", {
      call_id: call.call_id,
      principal_ref: principalRef,
      context_ref: call.context_ref,
      phase,
    });
    if (
      !Value.Check(ContextResponseSchema, response) ||
      response.call_id !== call.call_id ||
      response.context_ref !== call.context_ref
    )
      throw new BackendError("backend_context_mismatch");
    return response.context;
  }
  async delegate(delegation: Delegation): Promise<DelegationResult> {
    const response = await this.request("/voice/v1/delegations", delegation);
    if (
      !Value.Check(DelegationResultSchema, response) ||
      response.call_id !== delegation.call_id ||
      response.delegation_id !== delegation.delegation_id ||
      response.context_revision !== delegation.context_revision
    )
      throw new BackendError("backend_delegation_mismatch");
    return response;
  }
  async deliverEvent(event: CallEvent, signal?: AbortSignal): Promise<void> {
    const raw = JSON.stringify(event);
    const timestamp = String(Math.floor(this.now().getTime() / 1000));
    const response = await this.request(
      "/voice/v1/events",
      event,
      {
        "x-voxdock-timestamp": timestamp,
        "x-voxdock-signature": signEvent(
          this.options.eventSigningKey,
          timestamp,
          raw,
        ),
      },
      raw,
      signal,
    );
    if (
      !response ||
      typeof response !== "object" ||
      !("accepted" in response) ||
      response.accepted !== true ||
      !("event_id" in response) ||
      response.event_id !== event.event_id
    )
      throw new BackendError("backend_event_ack_mismatch");
  }
  private async request(
    path: string,
    payload: unknown,
    extraHeaders: Record<string, string> = {},
    raw = JSON.stringify(payload),
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (Buffer.byteLength(raw) > 65536)
      throw new BackendError("backend_request_too_large");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const endpoint = new URL(this.base);
      endpoint.pathname = this.base.pathname.replace(/\/$/, "") + path;
      const response = await this.fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.requestToken}`,
          ...extraHeaders,
        },
        body: raw,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new BackendError("backend_http_error");
      }
      if (!response.body) throw new BackendError("backend_empty_response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > 65536) {
            await reader.cancel();
            throw new BackendError("backend_response_too_large");
          }
          chunks.push(item.value);
        }
      } finally {
        reader.releaseLock();
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        throw new BackendError("backend_invalid_json");
      }
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError(
        controller.signal.aborted
          ? "backend_timeout"
          : "backend_transport_error",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
