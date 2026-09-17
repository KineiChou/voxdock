import type Database from "better-sqlite3";
import type { CallEvent, CallStatus } from "@voxdock/contracts";

export function migrateConsoleFacts(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE call_facts (
      call_id TEXT PRIMARY KEY REFERENCES calls(id), created_at TEXT NOT NULL,
      channel TEXT, actor_kind TEXT, connected INTEGER, connected_at TEXT,
      ended_at TEXT, had_uncertain_state INTEGER);
      CREATE INDEX console_call_order ON call_facts(created_at DESC,call_id DESC);
      CREATE TABLE transcript_cursors (cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL REFERENCES calls(id), id TEXT NOT NULL, UNIQUE(call_id,id));
      INSERT INTO transcript_cursors(call_id,id) SELECT call_id,id FROM transcripts ORDER BY rowid;`);
    const insert = db.prepare("INSERT INTO call_facts VALUES (?,?,?,?,?,?,?,?)");
    for (const row of db.prepare("SELECT body FROM calls").all() as { body: string }[]) {
      const call = JSON.parse(row.body) as CallStatus;
      const events = (db.prepare("SELECT body FROM events WHERE call_id=? ORDER BY cursor").all(call.call_id) as {body:string}[])
        .map(row => JSON.parse(row.body) as CallEvent);
      const complete = events.length === call.revision && events.every((event, index) => event.call_seq === index + 1);
      const connected = events.find(event => event.call.state === "connected");
      const connectedIndex = events.findIndex(event => event.call.state === "connected");
      const previous = events[connectedIndex - 1];
      const observedConnectionStart = connected && (complete || (previous &&
        previous.call_seq + 1 === connected.call_seq && ["requested", "dialing", "ringing"].includes(previous.call.state)));
      const uncertain = call.state === "uncertain" || events.some(event => event.call.state === "uncertain");
      insert.run(call.call_id,call.created_at,null,null,
        connected || call.state === "connected" ? 1 : complete ? 0 : null,
        observedConnectionStart ? connected.occurred_at : null,
        call.state === "ended" ? call.updated_at : null,
        uncertain ? 1 : complete ? 0 : null);
    }
    db.pragma("user_version = 2");
  }).immediate();
}
