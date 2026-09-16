import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  CallEvent,
  Delegation,
  DelegationResult,
} from "@voxdock/contracts";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export class ExampleConflict extends Error {}
export class ExampleStore {
  private readonly db: Database.Database;
  constructor(
    filename: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode=WAL");
    this.db.pragma("synchronous=FULL");
    this.db.pragma("busy_timeout=5000");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,delegation_id TEXT NOT NULL UNIQUE,call_id TEXT NOT NULL,principal_ref TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(delegation_id TEXT NOT NULL,revision INTEGER NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(delegation_id,revision));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,hash TEXT NOT NULL,call_id TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS completions(job_id TEXT NOT NULL,context_revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(job_id,context_revision));
      CREATE TABLE IF NOT EXISTS callbacks(result_id TEXT PRIMARY KEY,body TEXT NOT NULL,created_at TEXT NOT NULL,next_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',receipt TEXT);`);
  }
  close(): void {
    this.db.close();
  }
  delegate(input: Delegation): DelegationResult {
    return this.db
      .transaction(() => {
        const hash = digest(input);
        const prior = this.db
          .prepare(
            "SELECT hash,body FROM receipts WHERE delegation_id=? AND revision=?",
          )
          .get(input.delegation_id, input.context_revision) as
          | { hash: string; body: string }
          | undefined;
        if (prior) {
          if (prior.hash !== hash)
            throw new ExampleConflict("delegation_revision_conflict");
          return JSON.parse(prior.body) as DelegationResult;
        }
        const job = this.db
          .prepare(
            "SELECT id,call_id,principal_ref,revision FROM jobs WHERE delegation_id=?",
          )
          .get(input.delegation_id) as
          | {
              id: string;
              call_id: string;
              principal_ref: string;
              revision: number;
            }
          | undefined;
        if (
          job &&
          (job.call_id !== input.call_id ||
            job.principal_ref !== input.principal_ref ||
            job.revision >= input.context_revision)
        )
          throw new ExampleConflict("delegation_conflict");
        const id = job?.id ?? `example_job:${randomUUID()}`;
        const revision = this.nextResultRevision(input.delegation_id);
        const result: DelegationResult = {
          context_revision: input.context_revision,
          call_id: input.call_id,
          delegation_id: input.delegation_id,
          result_id: randomUUID(),
          revision,
          status: "accepted",
          business_ref: id,
          spoken_summary:
            "The example backend saved a simulated job. No real business action was performed.",
        };
        this.db
          .prepare(
            "INSERT INTO jobs VALUES (?,?,?,?,?,'accepted') ON CONFLICT(delegation_id) DO UPDATE SET revision=excluded.revision,status='accepted'",
          )
          .run(
            id,
            input.delegation_id,
            input.call_id,
            input.principal_ref,
            input.context_revision,
          );
        this.db
          .prepare("INSERT INTO receipts VALUES (?,?,?,?)")
          .run(
            input.delegation_id,
            input.context_revision,
            hash,
            JSON.stringify(result),
          );
        this.db
          .prepare(
            "UPDATE callbacks SET status='superseded' WHERE status='pending' AND json_extract(body,'$.delegation_id')=? AND json_extract(body,'$.context_revision')<?",
          )
          .run(input.delegation_id, input.context_revision);
        return result;
      })
      .immediate();
  }
  private nextResultRevision(delegationId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(revision),0)+1 AS revision FROM (SELECT CAST(json_extract(body,'$.revision') AS INTEGER) AS revision FROM receipts WHERE delegation_id=? UNION ALL SELECT CAST(json_extract(body,'$.revision') AS INTEGER) AS revision FROM completions WHERE json_extract(body,'$.delegation_id')=?)",
      )
      .get(delegationId, delegationId) as { revision: number };
    return row.revision;
  }
  complete(
    jobId: string,
    contextRevision: number,
  ): { result: DelegationResult; replayed: boolean } {
    return this.db
      .transaction(() => {
        const job = this.db
          .prepare("SELECT delegation_id,call_id,revision FROM jobs WHERE id=?")
          .get(jobId) as
          | { delegation_id: string; call_id: string; revision: number }
          | undefined;
        if (!job || job.revision !== contextRevision)
          throw new ExampleConflict("job_context_conflict");
        const prior = this.db
          .prepare(
            "SELECT body FROM completions WHERE job_id=? AND context_revision=?",
          )
          .get(jobId, contextRevision) as { body: string } | undefined;
        if (prior)
          return {
            result: JSON.parse(prior.body) as DelegationResult,
            replayed: true,
          };
        const result: DelegationResult = {
          call_id: job.call_id,
          delegation_id: job.delegation_id,
          context_revision: contextRevision,
          result_id: randomUUID(),
          revision: this.nextResultRevision(job.delegation_id),
          status: "completed",
          business_ref: jobId,
          spoken_summary:
            "The simulated example job is complete. No real business work was executed.",
        };
        const body = JSON.stringify(result);
        const now = this.now().toISOString();
        this.db
          .prepare("INSERT INTO completions VALUES (?,?,?)")
          .run(jobId, contextRevision, body);
        this.db
          .prepare(
            "INSERT INTO callbacks(result_id,body,created_at,next_at) VALUES (?,?,?,?)",
          )
          .run(result.result_id, body, now, now);
        this.db
          .prepare("UPDATE jobs SET status='completed' WHERE id=?")
          .run(jobId);
        return { result, replayed: false };
      })
      .immediate();
  }
  pendingCallbacks(limit = 10): DelegationResult[] {
    const now = this.now();
    this.db
      .prepare(
        "UPDATE callbacks SET status='failed' WHERE status='pending' AND created_at<=?",
      )
      .run(new Date(now.getTime() - 86400000).toISOString());
    return (
      this.db
        .prepare(
          "SELECT body FROM callbacks WHERE status='pending' AND next_at<=? ORDER BY rowid LIMIT ?",
        )
        .all(now.toISOString(), limit) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as DelegationResult);
  }
  callbackPending(resultId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM callbacks WHERE result_id=? AND status='pending'")
      .get(resultId);
  }
  acknowledgeCallback(
    resultId: string,
    receipt: { accepted: true; playback_status: string; replayed: boolean },
  ): void {
    this.db
      .prepare(
        "UPDATE callbacks SET status='accepted',receipt=? WHERE result_id=? AND status='pending'",
      )
      .run(JSON.stringify(receipt), resultId);
  }
  retryCallback(resultId: string): void {
    const row = this.db
      .prepare(
        "SELECT attempts FROM callbacks WHERE result_id=? AND status='pending'",
      )
      .get(resultId) as { attempts: number } | undefined;
    if (!row) return;
    const next = new Date(
      this.now().getTime() +
        Math.min(3600000, 1000 * 2 ** Math.min(row.attempts, 12)),
    ).toISOString();
    this.db
      .prepare(
        "UPDATE callbacks SET attempts=attempts+1,next_at=? WHERE result_id=?",
      )
      .run(next, resultId);
  }
  callbacks(): {
    result_id: string;
    status: string;
    attempts: number;
    receipt: unknown;
  }[] {
    return (
      this.db
        .prepare(
          "SELECT result_id,status,attempts,receipt FROM callbacks ORDER BY rowid",
        )
        .all() as {
        result_id: string;
        status: string;
        attempts: number;
        receipt: string | null;
      }[]
    ).map((row) => ({
      ...row,
      receipt: row.receipt ? (JSON.parse(row.receipt) as unknown) : null,
    }));
  }
  event(input: CallEvent): void {
    this.db
      .transaction(() => {
        const hash = digest(input);
        const prior = this.db
          .prepare("SELECT hash FROM events WHERE id=?")
          .get(input.event_id) as { hash: string } | undefined;
        if (prior) {
          if (prior.hash !== hash)
            throw new ExampleConflict("event_id_conflict");
          return;
        }
        this.db
          .prepare("INSERT INTO events VALUES (?,?,?,?)")
          .run(input.event_id, hash, input.call_id, input.call.revision);
        this.db
          .prepare(
            "INSERT INTO calls VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state WHERE excluded.revision>calls.revision",
          )
          .run(input.call_id, input.call.revision, input.call.state);
      })
      .immediate();
  }
  jobs(): { id: string; status: string; revision: number }[] {
    return this.db
      .prepare("SELECT id,status,revision FROM jobs ORDER BY rowid")
      .all() as { id: string; status: string; revision: number }[];
  }
}
