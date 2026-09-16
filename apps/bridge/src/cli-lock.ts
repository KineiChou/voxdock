import Database from "better-sqlite3";
import { resolve } from "node:path";
import { CliError } from "./cli-files.js";
export function acquireProcessLock(directory: string): () => void {
  let database: Database.Database | undefined;
  try {
    database = new Database(resolve(directory, "process-lock.sqlite"));
    database.pragma("busy_timeout=0");
    database.exec("BEGIN IMMEDIATE");
  } catch {
    database?.close();
    throw new CliError("already_running_or_data_unavailable");
  }
  const held = database;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      held.exec("ROLLBACK");
    } finally {
      held.close();
    }
  };
}
