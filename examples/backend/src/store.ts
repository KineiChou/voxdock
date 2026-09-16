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
  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode=WAL");
    this.db.pragma("synchronous=FULL");
    this.db.pragma("busy_timeout=5000");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,delegation_id TEXT NOT NULL UNIQUE,call_id TEXT NOT NULL,principal_ref TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(delegation_id TEXT NOT NULL,revision INTEGER NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(delegation_id,revision));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,hash TEXT NOT NULL,call_id TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL);`);
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
        const previousResult = this.db
          .prepare(
            "SELECT body FROM receipts WHERE delegation_id=? ORDER BY revision DESC LIMIT 1",
          )
          .get(input.delegation_id) as { body: string } | undefined;
        const revision = previousResult
          ? (JSON.parse(previousResult.body) as DelegationResult).revision + 1
          : 1;
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
            "INSERT INTO jobs VALUES (?,?,?,?,?,'accepted') ON CONFLICT(delegation_id) DO UPDATE SET revision=excluded.revision",
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
        return result;
      })
      .immediate();
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
