import type { CallStore } from "@voxdock/core";
import type { BackendClient } from "./client.js";
// One bridge process owns the database; process-wide serialization covers all worker instances.
let delivering = false;
export class OutboxWorker {
  constructor(
    private readonly client: BackendClient,
    private readonly store: CallStore,
    private readonly deadlineHours = 24,
  ) {}
  async runOnce(limit = 100): Promise<{ delivered: number; failed: number }> {
    if (delivering) return { delivered: 0, failed: 0 };
    delivering = true;
    let delivered = 0;
    let failed = 0;
    try {
      for (const event of this.store.pendingEvents(limit)) {
        try {
          await this.client.deliverEvent(event);
          this.store.acknowledgeEvent(event.event_id);
          delivered++;
        } catch {
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
