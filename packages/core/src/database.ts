import Database from "better-sqlite3";
export function openDatabase(filename: string): Database.Database {
  const db = new Database(filename);
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > 1) {
    db.close();
    throw new Error("Unsupported database schema version");
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, state TEXT NOT NULL, body TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_call ON calls((1)) WHERE state <> 'ended';
    CREATE TABLE IF NOT EXISTS recording (call_id TEXT PRIMARY KEY REFERENCES calls(id), availability TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commands (client TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, call_id TEXT NOT NULL REFERENCES calls(id), PRIMARY KEY(client,key));
    CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, call_id TEXT NOT NULL REFERENCES calls(id), body TEXT NOT NULL, created_at TEXT NOT NULL, delivery TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delegations (id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls(id), revision INTEGER NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, delegation_id TEXT NOT NULL REFERENCES delegations(id), revision INTEGER NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, playback_status TEXT NOT NULL, UNIQUE(delegation_id, revision));
    CREATE TABLE IF NOT EXISTS transcripts (call_id TEXT NOT NULL REFERENCES calls(id), id TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(call_id,id));
    CREATE TABLE IF NOT EXISTS usage (call_id TEXT PRIMARY KEY REFERENCES calls(id), day TEXT NOT NULL, zone TEXT NOT NULL, seconds REAL NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO metadata VALUES ('event_floor','0');
    PRAGMA user_version = 1;
  `);
  return db;
}
