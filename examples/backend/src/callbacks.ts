import type { ExampleStore } from "./store.js";
export interface CallbackOptions {
  bridgeBaseUrl: string;
  controlToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
export class CallbackWorker {
  private readonly base: URL;
  private active: Promise<{ accepted: number; failed: number }> | undefined;
  private stopped = false;
  private controller: AbortController | undefined;
  constructor(
    private readonly store: ExampleStore,
    private readonly options: CallbackOptions,
  ) {
    this.base = new URL(options.bridgeBaseUrl);
    if (
      !["http:", "https:"].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      options.controlToken.length < 32 ||
      /\s/.test(options.controlToken)
    )
      throw new Error("Invalid bridge callback configuration");
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 30000)
    )
      throw new Error("Invalid callback timeout");
  }
  runOnce(): Promise<{ accepted: number; failed: number }> {
    if (this.stopped) return Promise.resolve({ accepted: 0, failed: 0 });
    if (this.active) return this.active;
    this.active = this.deliver().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    await this.active;
  }
  private async deliver(): Promise<{ accepted: number; failed: number }> {
    let accepted = 0;
    let failed = 0;
    for (const result of this.store.pendingCallbacks()) {
      if (this.stopped) break;
      if (!this.store.callbackPending(result.result_id)) continue;
      const url = new URL(this.base);
      url.pathname =
        this.base.pathname.replace(/\/$/, "") +
        `/v1/calls/${encodeURIComponent(result.call_id)}/delegations/${encodeURIComponent(result.delegation_id)}/results`;
      const controller = new AbortController();
      this.controller = controller;
      const timer = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? 3000,
      );
      try {
        const response = await (this.options.fetch ?? fetch)(url, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.options.controlToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(result),
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error("callback_failed");
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            bytes += item.value.byteLength;
            if (bytes > 8192) {
              await reader.cancel();
              throw new Error("callback_response_too_large");
            }
            chunks.push(item.value);
          }
        } finally {
          reader.releaseLock();
        }
        const receipt = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          accepted?: unknown;
          playback_status?: unknown;
          replayed?: unknown;
        };
        if (
          receipt.accepted !== true ||
          !["eligible", "not_played"].includes(
            String(receipt.playback_status),
          ) ||
          typeof receipt.replayed !== "boolean"
        )
          throw new Error("invalid_callback_receipt");
        this.store.acknowledgeCallback(result.result_id, {
          accepted: true,
          playback_status: String(receipt.playback_status),
          replayed: receipt.replayed,
        });
        accepted++;
      } catch {
        this.store.retryCallback(result.result_id);
        failed++;
      } finally {
        clearTimeout(timer);
        this.controller = undefined;
      }
    }
    return { accepted, failed };
  }
}
