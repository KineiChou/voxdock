import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CallStatus,
  CallEvent,
  ConsoleCallQuery,
  ConsoleCallPage,
  ConsoleCallSummary,
  ConsoleCallDetail,
  ConsoleOverview,
  ConsoleTranscriptPage,
  ConsoleUsage,
  Delegation,
  DelegationResult,
  DelegationCounts,
  TranscriptFragment,
} from "@voxdock/contracts";
import { DomainError } from "./domain-error.js";

const states = [
  "requested",
  "dialing",
  "ringing",
  "connected",
  "ending",
  "ended",
  "uncertain",
];
const counts = (): DelegationCounts => ({
  total: 0,
  completed: 0,
  failed: 0,
  pending: 0,
});
function limit(value = 50, maximum = 100): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new DomainError("invalid_limit", 400);
  return value;
}
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decode(cursor: string, binding: string): { key: string; id: string } {
  try {
    if (
      typeof cursor !== "string" ||
      cursor.length > 2048 ||
      !/^[\w-]+$/.test(cursor)
    )
      throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      value.v !== 1 ||
      value.binding !== binding ||
      typeof value.key !== "string" ||
      typeof value.id !== "string"
    )
      throw new Error();
    return value;
  } catch {
    throw new DomainError("invalid_cursor", 400);
  }
}
function dayAt(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    throw new DomainError("invalid_timezone", 400);
  }
}
function startOfDay(day: string, zone: string): string {
  const center = Date.parse(day + "T00:00:00Z");
  let low = center - 36 * 3600000,
    high = center + 36 * 3600000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (dayAt(new Date(mid), zone) < day) low = mid + 1;
    else high = mid;
  }
  return new Date(low).toISOString();
}

export class ConsoleQueries {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date,
  ) {}
  private delegations(id: string): ConsoleCallDetail["delegations"] {
    return (
      this.db
        .prepare(
          `SELECT d.body, (SELECT r.body FROM results r WHERE r.delegation_id=d.id
      AND json_extract(r.body,'$.context_revision')=d.revision ORDER BY r.revision DESC LIMIT 1) result
      FROM delegations d WHERE d.call_id=? ORDER BY d.rowid`,
        )
        .all(id) as { body: string; result: string | null }[]
    ).map((row) => {
      const d = JSON.parse(row.body) as Delegation;
      return {
        delegation_id: d.delegation_id,
        context_revision: d.context_revision,
        occurred_at: d.occurred_at,
        completeness: d.completeness,
        latest_result: row.result
          ? (JSON.parse(row.result) as DelegationResult)
          : null,
      };
    });
  }
  private summary(id: string): ConsoleCallSummary {
    const row = this.db
      .prepare(
        `SELECT c.body,f.*,r.availability FROM calls c JOIN call_facts f ON f.call_id=c.id
      LEFT JOIN recording r ON r.call_id=c.id WHERE c.id=?`,
      )
      .get(id) as
      | {
          body: string;
          channel: ConsoleCallSummary["channel"];
          actor_kind: ConsoleCallSummary["actor_kind"];
          connected: number | null;
          connected_at: string | null;
          ended_at: string | null;
          had_uncertain_state: number | null;
          availability: ConsoleCallSummary["transcript_availability"] | null;
        }
      | undefined;
    if (!row) throw new DomainError("call_not_found", 404);
    const call = JSON.parse(row.body) as CallStatus;
    const delegations = counts();
    for (const d of this.delegations(id)) {
      delegations.total++;
      const status = d.latest_result?.status;
      if (status === "completed") delegations.completed++;
      else if (status === "failed") delegations.failed++;
      else delegations.pending++;
    }
    const usage = this.db
      .prepare("SELECT day,zone,seconds,status FROM usage WHERE call_id=?")
      .get(id) as
      | (Omit<ConsoleUsage, "status"> & { status: string })
      | undefined;
    return {
      call,
      can_end: ['requested', 'dialing', 'ringing', 'connected'].includes(call.state),
      channel: row.channel,
      actor_kind: row.actor_kind,
      connected: row.connected === null ? null : Boolean(row.connected),
      connected_at: row.connected_at,
      ended_at: row.ended_at,
      duration_seconds:
        row.connected_at && row.ended_at
          ? Math.max(
              0,
              (Date.parse(row.ended_at) - Date.parse(row.connected_at)) / 1000,
            )
          : call.state === "ended" && row.connected === 0
            ? 0
            : null,
      had_uncertain_state:
        row.had_uncertain_state === null
          ? null
          : Boolean(row.had_uncertain_state),
      usage: usage
        ? {
            ...usage,
            status:
              usage.status === "reserved" || usage.status === "settled"
                ? usage.status
                : "unknown",
          }
        : null,
      delegations,
      transcript_availability: row.availability ?? "empty",
    };
  }
  calls(query: ConsoleCallQuery = {}): ConsoleCallPage {
    const size = limit(query.limit);
    if (
      (query.channel !== undefined &&
        !["telegram", "whatsapp", "unknown"].includes(query.channel)) ||
      (query.direction !== undefined &&
        !["inbound", "outbound"].includes(query.direction)) ||
      (query.state !== undefined && !states.includes(query.state))
    )
      throw new DomainError("invalid_filter", 400);
    const normalized: Record<string, string> = {};
    for (const key of ["from", "to"] as const)
      if (query[key] !== undefined) {
        if (
          typeof query[key] !== "string" ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(query[key]) ||
          !Number.isFinite(Date.parse(query[key]))
        )
          throw new DomainError("invalid_filter", 400);
        normalized[key] = new Date(query[key]).toISOString();
        const exact = query[key].replace(
          /(?:\.(\d{1,3}))?Z$/,
          (_, fraction: string | undefined) =>
            `.${(fraction ?? "").padEnd(3, "0")}Z`,
        );
        if (normalized[key] !== exact)
          throw new DomainError("invalid_filter", 400);
      }
    if (normalized.from && normalized.to && normalized.from >= normalized.to)
      throw new DomainError("invalid_filter", 400);
    const binding = createHash("sha256")
      .update(
        JSON.stringify([
          query.channel ?? null,
          query.direction ?? null,
          query.state ?? null,
          normalized.from ?? null,
          normalized.to ?? null,
        ]),
      )
      .digest("hex");
    const where: string[] = [],
      args: (string | number)[] = [];
    if (query.channel === "unknown") where.push("f.channel IS NULL");
    else if (query.channel) {
      where.push("f.channel=?");
      args.push(query.channel);
    }
    if (query.direction) {
      where.push("json_extract(c.body,'$.direction')=?");
      args.push(query.direction);
    }
    if (query.state) {
      where.push("c.state=?");
      args.push(query.state);
    }
    if (normalized.from) {
      where.push("f.created_at>=?");
      args.push(normalized.from);
    }
    if (normalized.to) {
      where.push("f.created_at<?");
      args.push(normalized.to);
    }
    const base =
      "FROM calls c JOIN call_facts f ON f.call_id=c.id WHERE " +
      (where.join(" AND ") || "1");
    const total = (
      this.db.prepare("SELECT COUNT(*) total " + base).get(...args) as {
        total: number;
      }
    ).total;
    let seek = "";
    if (query.cursor !== undefined) {
      const cursor = decode(query.cursor, binding);
      if (
        !Number.isFinite(Date.parse(cursor.key)) ||
        !cursor.id ||
        cursor.id.length > 200
      )
        throw new DomainError("invalid_cursor", 400);
      seek = " AND (f.created_at<? OR (f.created_at=? AND c.id<?))";
      args.push(cursor.key, cursor.key, cursor.id);
    }
    const rows = this.db
      .prepare(
        "SELECT c.id,f.created_at " +
          base +
          seek +
          " ORDER BY f.created_at DESC,c.id DESC LIMIT ?",
      )
      .all(...args, size + 1) as { id: string; created_at: string }[];
    const selected = rows.slice(0, size),
      last = selected.at(-1);
    return {
      total,
      items: selected.map((row) => this.summary(row.id)),
      next_cursor:
        rows.length > size && last
          ? encode({ v: 1, binding, key: last.created_at, id: last.id })
          : null,
    };
  }
  call(id: string): ConsoleCallDetail {
    const summary = this.summary(id);
    return {
      summary,
      events: (
        this.db
          .prepare("SELECT body FROM events WHERE call_id=? ORDER BY cursor")
          .all(id) as { body: string }[]
      ).map((row) => JSON.parse(row.body) as CallEvent),
      delegations: this.delegations(id),
    };
  }
  transcripts(
    id: string,
    options: { cursor?: string; limit?: number } = {},
  ): ConsoleTranscriptPage {
    const availability = this.summary(id).transcript_availability;
    const size = limit(options.limit, 200),
      binding = "transcripts:" + id;
    const cursor =
      options.cursor === undefined ? null : decode(options.cursor, binding);
    const after = cursor ? Number(cursor.key) : 0;
    if (!Number.isSafeInteger(after) || after < 0)
      throw new DomainError("invalid_cursor", 400);
    const rows = this.db
      .prepare(
        "SELECT o.cursor,t.body FROM transcripts t JOIN transcript_cursors o ON o.call_id=t.call_id AND o.id=t.id WHERE t.call_id=? AND o.cursor>? ORDER BY o.cursor LIMIT ?",
      )
      .all(id, after, size + 1) as { cursor: number; body: string }[];
    const selected = rows.slice(0, size),
      last = selected.at(-1);
    return {
      availability,
      fragments: selected.map(
        (row) => JSON.parse(row.body) as TranscriptFragment,
      ),
      next_cursor:
        rows.length > size && last
          ? encode({ v: 1, binding, key: String(last.cursor), id })
          : null,
    };
  }
  overview(options: {
    days: 1 | 7 | 30;
    timeZone: string;
    dailySeconds: number;
  }): ConsoleOverview {
    if (
      ![1, 7, 30].includes(options.days) ||
      !Number.isFinite(options.dailySeconds) ||
      options.dailySeconds < 0
    )
      throw new DomainError("invalid_overview", 400);
    if (
      this.db
        .prepare("SELECT 1 FROM usage WHERE zone<>? LIMIT 1")
        .get(options.timeZone)
    )
      throw new DomainError("usage_timezone_conflict", 409);
    const now = this.now(),
      today = dayAt(now, options.timeZone);
    const dates = Array.from({ length: options.days }, (_, i) =>
      new Date(
        Date.parse(today + "T00:00:00Z") - (options.days - i - 1) * 86400000,
      )
        .toISOString()
        .slice(0, 10),
    );
    const periodFrom = startOfDay(dates[0]!, options.timeZone);
    const daily = dates.map((date) => ({
      date,
      calls: 0,
      connected_calls: 0,
      settled_live_seconds: 0,
    }));
    const totals: ConsoleOverview["totals"] = {
      calls: 0,
      connected_calls: 0,
      observed_calls: 0,
      unknown_outcomes: 0,
      connection_rate: null,
      settled_live_seconds: 0,
      reserved_live_seconds: 0,
      unknown_live_seconds: 0,
      delegations: counts(),
    };
    const channels: ConsoleOverview["channels"] = [
      "telegram",
      "whatsapp",
      "unknown",
    ].map((channel) => ({
      channel: channel as "telegram" | "whatsapp" | "unknown",
      calls: 0,
    }));
    const rows = this.db
      .prepare(
        "SELECT c.id FROM calls c JOIN call_facts f ON f.call_id=c.id WHERE f.created_at>=? AND f.created_at<=? ORDER BY f.created_at DESC,c.id DESC",
      )
      .all(periodFrom, now.toISOString()) as { id: string }[];
    let connectedTerminal = 0;
    for (const row of rows) {
      const item = this.summary(row.id);
      totals.calls++;
      const bucket = daily.find(
        (d) =>
          d.date === dayAt(new Date(item.call.created_at), options.timeZone),
      );
      if (bucket) {
        bucket.calls++;
        if (item.connected) bucket.connected_calls++;
      }
      channels.find((c) => c.channel === (item.channel ?? "unknown"))!.calls++;
      if (item.connected) totals.connected_calls++;
      if (item.call.state === "ended") {
        if (item.connected === null) totals.unknown_outcomes++;
        else {
          totals.observed_calls++;
          if (item.connected) connectedTerminal++;
        }
      }
      for (const key of ["total", "completed", "failed", "pending"] as const)
        totals.delegations[key] += item.delegations[key];
    }
    totals.connection_rate = totals.observed_calls
      ? connectedTerminal / totals.observed_calls
      : null;
    const todayUsage: ConsoleOverview["today_usage"] = {
      date: today,
      limit_seconds: options.dailySeconds,
      settled_seconds: 0,
      reserved_seconds: 0,
      unknown_seconds: 0,
      remaining_seconds: 0,
    };
    for (const usage of this.db
      .prepare(
        "SELECT day,zone,seconds,status FROM usage WHERE day>=? AND day<=?",
      )
      .all(dates[0]!, today) as {
      day: string;
      zone: string;
      seconds: number;
      status: string;
    }[]) {
      const status =
        usage.status === "settled" || usage.status === "reserved"
          ? usage.status
          : "unknown";
      totals[`${status}_live_seconds`] += usage.seconds;
      if (status === "settled")
        daily.find((d) => d.date === usage.day)!.settled_live_seconds +=
          usage.seconds;
      if (usage.day === today) todayUsage[`${status}_seconds`] += usage.seconds;
    }
    todayUsage.remaining_seconds = Math.max(
      0,
      options.dailySeconds -
        todayUsage.settled_seconds -
        todayUsage.reserved_seconds -
        todayUsage.unknown_seconds,
    );
    const active = (
      this.db
        .prepare(
          "SELECT id FROM calls WHERE state<>'ended' ORDER BY rowid DESC",
        )
        .all() as { id: string }[]
    ).map((row) => this.summary(row.id));
    return {
      generated_at: now.toISOString(),
      timezone: options.timeZone,
      days: options.days,
      period_from: periodFrom,
      totals,
      daily,
      channels,
      today_usage: todayUsage,
      active_calls: active,
      recent_calls: this.calls({ limit: 10 }).items,
      attention_calls: active.filter((item) => item.call.state === "uncertain"),
    };
  }
}
