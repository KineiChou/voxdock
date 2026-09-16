import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { Value } from "@sinclair/typebox/value";
import {
  CallRequestSchema,
  DelegationSchema,
  DelegationResultSchema,
  TranscriptFragmentSchema,
  type CallRequest,
  type CallStatus,
  type CallState,
  type CallEvent,
  type Delegation,
  type DelegationResult,
  type TranscriptFragment,
} from "@voxdock/contracts";
import { openDatabase } from "./database.js";
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(code);
    this.name = "DomainError";
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
const transitions: Record<CallState, readonly CallState[]> = {
  requested: [
    "dialing",
    "ringing",
    "connected",
    "ending",
    "ended",
    "uncertain",
  ],
  dialing: ["ringing", "connected", "ending", "ended", "uncertain"],
  ringing: ["connected", "ending", "ended", "uncertain"],
  connected: ["ending", "ended", "uncertain"],
  ending: ["ended", "uncertain"],
  uncertain: ["ending", "ended"],
  ended: [],
};
export type CallPatch = Partial<
  Pick<
    CallStatus,
    "reason" | "provider_call_ref" | "audio_ready" | "live_ready"
  >
>;
export interface CreateCallOptions {
  enabled: boolean;
  allowedTargets: Set<string>;
  maxTtlSeconds: number;
  direction?: "inbound" | "outbound";
}
export class CallStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly persistTranscripts: boolean;
  constructor(
    filename: string,
    options: { now?: () => Date; persistTranscripts?: boolean } = {},
  ) {
    this.db = openDatabase(filename);
    this.now = options.now ?? (() => new Date());
    this.persistTranscripts = options.persistTranscripts ?? true;
  }
  private captureTranscripts(callId: string): boolean {
    const row = this.db
      .prepare("SELECT availability FROM recording WHERE call_id=?")
      .get(callId) as { availability: string } | undefined;
    return (
      this.persistTranscripts &&
      row?.availability !== "disabled" &&
      row?.availability !== "expired"
    );
  }
  setPaused(paused: boolean): void {
    this.db
      .prepare(
        "INSERT INTO metadata VALUES ('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(paused));
  }
  isPaused(defaultPaused: boolean): boolean {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key='paused'")
      .get() as { value: string } | undefined;
    return row ? row.value === "true" : defaultPaused;
  }
  getRecord(callId: string) {
    const call = this.getCall(callId);
    const rows = (query: string) =>
      (this.db.prepare(query).all(callId) as { body: string }[]).map(
        (row) => JSON.parse(row.body) as unknown,
      );
    const availability = this.db
      .prepare("SELECT availability FROM recording WHERE call_id=?")
      .get(callId) as { availability: string } | undefined;
    return {
      call,
      events: rows(
        "SELECT body FROM events WHERE call_id=? ORDER BY cursor",
      ) as CallEvent[],
      delegations: rows(
        "SELECT body FROM delegations WHERE call_id=? ORDER BY rowid",
      ) as Delegation[],
      results: rows(
        "SELECT results.body FROM results JOIN delegations ON delegations.id=results.delegation_id WHERE delegations.call_id=? ORDER BY results.rowid",
      ) as DelegationResult[],
      transcripts: rows(
        "SELECT body FROM transcripts WHERE call_id=? ORDER BY rowid",
      ) as TranscriptFragment[],
      transcript_availability: availability?.availability ?? "empty",
      usage: this.db
        .prepare("SELECT day,zone,seconds,status FROM usage WHERE call_id=?")
        .get(callId) as
        | { day: string; zone: string; seconds: number; status: string }
        | undefined,
    };
  }
  close(): void {
    this.db.close();
  }
  getCall(id: string): CallStatus {
    const row = this.db.prepare("SELECT body FROM calls WHERE id=?").get(id) as
      | { body: string }
      | undefined;
    if (!row) throw new DomainError("call_not_found", 404);
    return JSON.parse(row.body) as CallStatus;
  }
  listCalls(): CallStatus[] {
    return (
      this.db.prepare("SELECT body FROM calls ORDER BY rowid DESC").all() as {
        body: string;
      }[]
    ).map((row) => JSON.parse(row.body) as CallStatus);
  }
  createCall(
    clientId: string,
    key: string,
    request: CallRequest,
    options: CreateCallOptions,
  ): { call: CallStatus; replayed: boolean } {
    if (!clientId || clientId.length > 200 || !key || key.length > 200)
      throw new DomainError("invalid_idempotency_key", 400);
    if (!Value.Check(CallRequestSchema, request))
      throw new DomainError("invalid_call_request", 400);
    const digest = hash({
      request,
      direction: options.direction ?? "outbound",
    });
    return this.db
      .transaction(() => {
        const command = this.db
          .prepare("SELECT hash,call_id FROM commands WHERE client=? AND key=?")
          .get(clientId, key) as { hash: string; call_id: string } | undefined;
        if (command) {
          if (command.hash !== digest)
            throw new DomainError("idempotency_conflict", 409);
          return { call: this.getCall(command.call_id), replayed: true };
        }
        if (
          !Number.isFinite(options.maxTtlSeconds) ||
          options.maxTtlSeconds <= 0
        )
          throw new DomainError("invalid_request_ttl", 400);
        if (!options.enabled) throw new DomainError("calling_disabled", 503);
        if (!options.allowedTargets.has(request.target_id))
          throw new DomainError("target_unavailable", 403);
        const now = this.now();
        const expiry = Date.parse(request.expires_at);
        const normalizedExpiry = request.expires_at.replace(
          /(?:\.(\d{1,3}))?Z$/,
          (_, fraction: string | undefined) =>
            `.${(fraction ?? "").padEnd(3, "0")}Z`,
        );
        if (
          !Number.isFinite(expiry) ||
          new Date(expiry).toISOString() !== normalizedExpiry
        )
          throw new DomainError("invalid_expiry", 400);
        if (
          expiry <= now.getTime() ||
          expiry > now.getTime() + options.maxTtlSeconds * 1000
        )
          throw new DomainError("expiry_out_of_range", 400);
        if (this.db.prepare("SELECT 1 FROM calls WHERE state <> 'ended'").get())
          throw new DomainError("call_capacity", 409);
        const call: CallStatus = {
          ...request,
          call_id: randomUUID(),
          direction: options.direction ?? "outbound",
          state: "requested",
          revision: 1,
          audio_ready: false,
          live_ready: false,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        };
        this.db
          .prepare("INSERT INTO calls VALUES (?,?,?)")
          .run(call.call_id, call.state, JSON.stringify(call));
        this.db
          .prepare("INSERT INTO recording VALUES (?,?)")
          .run(call.call_id, this.persistTranscripts ? "empty" : "disabled");
        this.db
          .prepare("INSERT INTO commands VALUES (?,?,?,?)")
          .run(clientId, key, digest, call.call_id);
        this.emit(call);
        return { call, replayed: false };
      })
      .immediate();
  }
  transition(id: string, state: CallState, patch: CallPatch = {}): CallStatus {
    return this.db
      .transaction(() => {
        const previous = this.getCall(id);
        if (
          state === previous.state &&
          Object.entries(patch).every(
            ([key, value]) => previous[key as keyof CallStatus] === value,
          )
        )
          return previous;
        if (
          previous.state === "ended" ||
          (state !== previous.state &&
            !transitions[previous.state].includes(state))
        )
          throw new DomainError("invalid_call_transition", 409);
        const call: CallStatus = {
          ...previous,
          ...patch,
          state,
          revision: previous.revision + 1,
          updated_at: this.now().toISOString(),
        };
        if (state === "ended" || state === "uncertain" || state === "ending") {
          call.audio_ready = false;
          call.live_ready = false;
        }
        this.db
          .prepare("UPDATE calls SET state=?,body=? WHERE id=?")
          .run(state, JSON.stringify(call), id);
        this.emit(call);
        return call;
      })
      .immediate();
  }
  private emit(call: CallStatus): void {
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    const event: CallEvent = {
      schema_version: 1,
      event_id: id,
      cursor: 0,
      call_id: call.call_id,
      call_seq: call.revision,
      occurred_at: timestamp,
      type: "call.updated",
      call,
    };
    const inserted = this.db
      .prepare(
        "INSERT INTO events (id,call_id,body,created_at,next_at) VALUES (?,?,?,?,?)",
      )
      .run(id, call.call_id, "{}", timestamp, timestamp);
    event.cursor = Number(inserted.lastInsertRowid);
    this.db
      .prepare("UPDATE events SET body=? WHERE cursor=?")
      .run(JSON.stringify(event), event.cursor);
  }
  recover(): CallStatus[] {
    return this.db
      .transaction(() =>
        this.listCalls()
          .filter((call) => call.state !== "ended")
          .map((call) =>
            this.transition(
              call.call_id,
              call.state === "requested" ? "ended" : "uncertain",
              {
                reason:
                  call.state === "requested"
                    ? "cancelled"
                    : "restart_requires_reconciliation",
              },
            ),
          ),
      )
      .immediate();
  }
  events(after = 0, limit = 100): CallEvent[] {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new DomainError("invalid_cursor", 400);
    const floor = Number(
      (
        this.db
          .prepare("SELECT value FROM metadata WHERE key='event_floor'")
          .get() as { value: string }
      ).value,
    );
    if (after < floor) throw new DomainError("cursor_expired", 410);
    return (
      this.db
        .prepare(
          "SELECT body FROM events WHERE cursor>? ORDER BY cursor LIMIT ?",
        )
        .all(after, limit) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as CallEvent);
  }
  pendingEvents(limit = 100): CallEvent[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM events WHERE delivery='pending' AND next_at<=? ORDER BY cursor LIMIT ?",
        )
        .all(this.now().toISOString(), Math.max(1, Math.min(1000, limit))) as {
        body: string;
      }[]
    ).map((row) => JSON.parse(row.body) as CallEvent);
  }
  acknowledgeEvent(id: string): void {
    this.db.prepare("UPDATE events SET delivery='acked' WHERE id=?").run(id);
  }
  retryEvent(
    id: string,
    { deadlineHours = 24 }: { deadlineHours?: number } = {},
  ): "pending" | "failed" {
    const event = this.db
      .prepare("SELECT created_at,attempts,delivery FROM events WHERE id=?")
      .get(id) as
      | { created_at: string; attempts: number; delivery: string }
      | undefined;
    if (!event) throw new DomainError("event_not_found", 404);
    if (event.delivery === "acked")
      throw new DomainError("event_already_acknowledged", 409);
    const failed =
      event.delivery === "failed" ||
      this.now().getTime() - Date.parse(event.created_at) >=
        deadlineHours * 3600000;
    const status = failed ? "failed" : "pending";
    const delay = Math.min(3600000, 1000 * 2 ** Math.min(event.attempts, 12));
    this.db
      .prepare(
        "UPDATE events SET delivery=?,attempts=attempts+1,next_at=? WHERE id=?",
      )
      .run(status, new Date(this.now().getTime() + delay).toISOString(), id);
    return status;
  }
  recordDelegation(delegation: Delegation): {
    delegation: Delegation;
    replayed: boolean;
  } {
    if (!Value.Check(DelegationSchema, delegation))
      throw new DomainError("invalid_delegation", 400);
    return this.db
      .transaction(() => {
        const call = this.getCall(delegation.call_id);
        const digest = hash(delegation);
        const prior = this.db
          .prepare(
            "SELECT call_id,revision,hash,body FROM delegations WHERE id=?",
          )
          .get(delegation.delegation_id) as
          | { call_id: string; revision: number; hash: string; body: string }
          | undefined;
        if (prior) {
          if (prior.call_id !== delegation.call_id)
            throw new DomainError("delegation_call_conflict", 409);
          if (prior.revision === delegation.context_revision) {
            if (prior.hash !== digest)
              throw new DomainError("delegation_revision_conflict", 409);
            return {
              delegation,
              replayed: true,
            };
          }
          if (prior.revision > delegation.context_revision)
            throw new DomainError("stale_delegation", 409);
        }
        if (call.state !== "connected")
          throw new DomainError("call_not_connected", 409);
        this.db
          .prepare(
            "INSERT INTO delegations VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,hash=excluded.hash,body=excluded.body",
          )
          .run(
            delegation.delegation_id,
            delegation.call_id,
            delegation.context_revision,
            digest,
            JSON.stringify(
              this.captureTranscripts(delegation.call_id)
                ? delegation
                : { ...delegation, fragments: [] },
            ),
          );
        if (
          this.captureTranscripts(delegation.call_id) &&
          delegation.fragments.length
        )
          this.db
            .prepare(
              "UPDATE recording SET availability='available' WHERE call_id=?",
            )
            .run(delegation.call_id);
        return { delegation, replayed: false };
      })
      .immediate();
  }
  recordResult(result: DelegationResult): {
    result: DelegationResult;
    replayed: boolean;
    playback_status: "eligible" | "not_played";
  } {
    if (!Value.Check(DelegationResultSchema, result))
      throw new DomainError("invalid_result", 400);
    return this.db
      .transaction(() => {
        const digest = hash(result);
        const prior = this.db
          .prepare("SELECT hash,body,playback_status FROM results WHERE id=?")
          .get(result.result_id) as
          | {
              hash: string;
              body: string;
              playback_status: "eligible" | "not_played";
            }
          | undefined;
        if (prior) {
          if (prior.hash !== digest)
            throw new DomainError("result_id_conflict", 409);
          return {
            result: JSON.parse(prior.body) as DelegationResult,
            replayed: true,
            playback_status: "not_played" as const,
          };
        }
        const delegation = this.db
          .prepare("SELECT call_id FROM delegations WHERE id=?")
          .get(result.delegation_id) as { call_id: string } | undefined;
        if (!delegation || delegation.call_id !== result.call_id)
          throw new DomainError("delegation_not_found", 404);
        const latest = this.db
          .prepare(
            "SELECT revision FROM results WHERE delegation_id=? ORDER BY revision DESC LIMIT 1",
          )
          .get(result.delegation_id) as { revision: number } | undefined;
        if (latest && latest.revision >= result.revision)
          throw new DomainError("result_revision_conflict", 409);
        const call = this.getCall(result.call_id);
        const playback_status =
          call.state === "connected" && call.live_ready
            ? ("eligible" as const)
            : ("not_played" as const);
        this.db
          .prepare("INSERT INTO results VALUES (?,?,?,?,?,?)")
          .run(
            result.result_id,
            result.delegation_id,
            result.revision,
            digest,
            JSON.stringify(result),
            playback_status,
          );
        return { result, replayed: false, playback_status };
      })
      .immediate();
  }
  appendTranscript(callId: string, fragment: TranscriptFragment): void {
    if (
      !Value.Check(TranscriptFragmentSchema, fragment) ||
      fragment.end_ms < fragment.start_ms
    )
      throw new DomainError("invalid_transcript", 400);
    this.db
      .transaction(() => {
        this.getCall(callId);
        if (!this.captureTranscripts(callId)) return;
        const digest = hash(fragment);
        const prior = this.db
          .prepare("SELECT hash FROM transcripts WHERE call_id=? AND id=?")
          .get(callId, fragment.id) as { hash: string } | undefined;
        if (prior) {
          if (prior.hash !== digest)
            throw new DomainError("transcript_conflict", 409);
          return;
        }
        this.db
          .prepare("INSERT INTO transcripts VALUES (?,?,?,?,?)")
          .run(
            callId,
            fragment.id,
            digest,
            JSON.stringify(fragment),
            this.now().toISOString(),
          );
        this.db
          .prepare(
            "UPDATE recording SET availability='available' WHERE call_id=?",
          )
          .run(callId);
      })
      .immediate();
  }
  reserveUsage(
    callId: string,
    {
      dailySeconds,
      maxSeconds,
      timeZone,
    }: { dailySeconds: number; maxSeconds: number; timeZone: string },
  ): number {
    if (
      !Number.isFinite(dailySeconds) ||
      !Number.isFinite(maxSeconds) ||
      dailySeconds <= 0 ||
      maxSeconds <= 0
    )
      throw new DomainError("invalid_usage_limit", 400);
    let day: string;
    try {
      day = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(this.now());
    } catch {
      throw new DomainError("invalid_timezone", 400);
    }
    return this.db
      .transaction(() => {
        const call = this.getCall(callId);
        const prior = this.db
          .prepare("SELECT seconds FROM usage WHERE call_id=?")
          .get(callId) as { seconds: number } | undefined;
        if (prior) return prior.seconds;
        if (call.state === "ended" || call.state === "uncertain")
          throw new DomainError("call_not_active", 409);
        const zones = this.db
          .prepare("SELECT zone FROM usage LIMIT 1")
          .get() as { zone: string } | undefined;
        if (zones && zones.zone !== timeZone)
          throw new DomainError("usage_timezone_conflict", 409);
        const used = (
          this.db
            .prepare(
              "SELECT COALESCE(SUM(seconds),0) AS seconds FROM usage WHERE day=?",
            )
            .get(day) as { seconds: number }
        ).seconds;
        if (used + maxSeconds > dailySeconds)
          throw new DomainError("daily_usage_limit", 429);
        this.db
          .prepare("INSERT INTO usage VALUES (?,?,?,?,'reserved')")
          .run(callId, day, timeZone, maxSeconds);
        return maxSeconds;
      })
      .immediate();
  }
  settleUsage(callId: string, seconds?: number): void {
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0))
      throw new DomainError("invalid_usage", 400);
    this.db
      .transaction(() => {
        const usage = this.db
          .prepare("SELECT seconds,status FROM usage WHERE call_id=?")
          .get(callId) as { seconds: number; status: string } | undefined;
        if (!usage) throw new DomainError("usage_not_reserved", 404);
        if (usage.status === "settled") {
          if (seconds !== usage.seconds)
            throw new DomainError("usage_settlement_conflict", 409);
          return;
        }
        this.db
          .prepare("UPDATE usage SET seconds=?,status=? WHERE call_id=?")
          .run(
            seconds ?? usage.seconds,
            seconds === undefined ? "incomplete" : "settled",
            callId,
          );
      })
      .immediate();
  }
  prune({
    metadataBefore,
    transcriptsBefore,
  }: {
    metadataBefore: string;
    transcriptsBefore: string;
  }): void {
    if (
      !Number.isFinite(Date.parse(metadataBefore)) ||
      !Number.isFinite(Date.parse(transcriptsBefore))
    )
      throw new DomainError("invalid_retention_cutoff", 400);
    this.db
      .transaction(() => {
        const expiredCalls = new Set(
          (
            this.db
              .prepare(
                "SELECT DISTINCT call_id FROM transcripts WHERE created_at<?",
              )
              .all(transcriptsBefore) as { call_id: string }[]
          ).map((row) => row.call_id),
        );
        for (const row of this.db
          .prepare("SELECT id,call_id,body FROM delegations")
          .all() as { id: string; call_id: string; body: string }[]) {
          const delegation = JSON.parse(row.body) as Delegation;
          if (
            delegation.occurred_at < transcriptsBefore &&
            delegation.fragments.length
          ) {
            this.db
              .prepare("UPDATE delegations SET body=? WHERE id=?")
              .run(JSON.stringify({ ...delegation, fragments: [] }), row.id);
            expiredCalls.add(row.call_id);
          }
        }
        for (const callId of expiredCalls)
          this.db
            .prepare(
              "UPDATE recording SET availability='expired' WHERE call_id=? AND availability<>'disabled'",
            )
            .run(callId);
        this.db
          .prepare("DELETE FROM transcripts WHERE created_at<?")
          .run(transcriptsBefore);
        for (const row of this.db
          .prepare(
            "SELECT results.id,results.body FROM results JOIN delegations ON delegations.id=results.delegation_id JOIN calls ON calls.id=delegations.call_id WHERE calls.state='ended' AND json_extract(calls.body,'$.updated_at')<?",
          )
          .all(metadataBefore) as { id: string; body: string }[]) {
          const result = JSON.parse(row.body) as DelegationResult;
          this.db
            .prepare("UPDATE results SET body=?,playback_status=? WHERE id=?")
            .run(
              JSON.stringify({
                ...result,
                spoken_summary: "[expired]",
                evidence_urls: [],
              }),
              "not_played",
              row.id,
            );
        }
        // Keep call/command tombstones to prevent replay; purge only an acknowledged terminal event prefix.
        const rows = this.db
          .prepare(
            "SELECT cursor,call_id,created_at,delivery FROM events ORDER BY cursor",
          )
          .all() as {
          cursor: number;
          call_id: string;
          created_at: string;
          delivery: string;
        }[];
        let floor = 0;
        for (const event of rows) {
          if (
            event.created_at >= metadataBefore ||
            event.delivery === "pending" ||
            this.getCall(event.call_id).state !== "ended"
          )
            break;
          floor = event.cursor;
        }
        if (floor) {
          this.db.prepare("DELETE FROM events WHERE cursor<=?").run(floor);
          this.db
            .prepare("UPDATE metadata SET value=? WHERE key='event_floor'")
            .run(String(floor));
        }
      })
      .immediate();
  }
}
