import type { CallStore } from "@voxdock/core";
import type { BackendClient } from "./client.js";
// One bridge process owns the database; process-wide serialization covers all worker instances.
let delivering = false;
export class OutboxWorker {
  constructor(
    private readonly client: Pick<BackendClient, 'deliverEvent'>,
    private readonly store: CallStore,
    private readonly deadlineHours = 24,
  ) {}
  async runOnce(limit = 100, signal?: AbortSignal): Promise<{ delivered: number; failed: number }> {
    if (delivering) return { delivered: 0, failed: 0 };
    delivering = true;
    let delivered = 0;
    let failed = 0;
    try {
      for (const event of this.store.pendingEvents(limit)) {
        if (signal?.aborted) break;
        try {
          await this.client.deliverEvent(event, signal);
          if (signal?.aborted) break;
          this.store.acknowledgeEvent(event.event_id);
          delivered++;
        } catch {
          if (signal?.aborted) break;
          this.store.retryEvent(event.event_id, {
            deadlineHours: this.deadlineHours,
          });
          failed++;
        }
      }
    } finally {
      delivering = false;
    }
    return { delivered, failed };
  }
}
