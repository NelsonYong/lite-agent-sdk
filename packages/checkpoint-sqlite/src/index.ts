import Database from "better-sqlite3";
import type { Checkpointer, SessionEvent, StoredEvent, SessionInfo } from "@lite-agent/core";
import { CheckpointConflictError } from "@lite-agent/core";

export interface SqliteCheckpointerOptions {
  /** Path to the SQLite database file. Use ":memory:" for an ephemeral DB. */
  file: string;
}

export interface SqliteCheckpointer extends Checkpointer {
  close(): void;
}

export function sqliteCheckpointer(opts: SqliteCheckpointerOptions): SqliteCheckpointer {
  const db = new Database(opts.file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, parent_seq INTEGER,
      ts TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq));
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, updated TEXT NOT NULL, head INTEGER NOT NULL);
  `);

  const headStmt = db.prepare<[string]>("SELECT head FROM sessions WHERE id = ?");
  const insertEvt = db.prepare(
    "INSERT INTO events (session_id, seq, parent_seq, ts, payload) VALUES (?, ?, ?, ?, ?)",
  );
  const upsertSession = db.prepare(
    "INSERT INTO sessions (id, updated, head) VALUES (?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET updated = excluded.updated, head = excluded.head",
  );

  const headOf = (id: string): number => (headStmt.get(id) as { head: number } | undefined)?.head ?? 0;

  const appendTxn = db.transaction((id: string, events: SessionEvent[], expectedHead?: number): number => {
    const head = headOf(id);
    if (expectedHead !== undefined && expectedHead !== head)
      throw new CheckpointConflictError(id, expectedHead, head);
    const ts = new Date().toISOString();
    let seq = head;
    for (const event of events) {
      seq++;
      insertEvt.run(id, seq, seq === 1 ? null : seq - 1, ts, JSON.stringify(event));
    }
    upsertSession.run(id, ts, seq);
    return seq;
  });

  const truncateTxn = db.transaction((id: string, toSeq: number) => {
    db.prepare("DELETE FROM events WHERE session_id = ? AND seq > ?").run(id, toSeq);
    const row = db.prepare("SELECT MAX(seq) AS m FROM events WHERE session_id = ?").get(id) as { m: number | null };
    const newHead = row.m ?? 0;
    db.prepare("UPDATE sessions SET head = ?, updated = ? WHERE id = ?").run(newHead, new Date().toISOString(), id);
  });

  return {
    async append(sessionId, events, expectedHead) {
      // BEGIN IMMEDIATE (spec §6): take the write lock up front so a competing
      // writer waits on busy_timeout instead of failing with SQLITE_BUSY_SNAPSHOT,
      // then reads a fresh head and throws CheckpointConflictError cleanly.
      return appendTxn.immediate(sessionId, events, expectedHead);
    },
    async *read(sessionId, opts2) {
      const rows = db
        .prepare<[string, number]>(
          "SELECT seq, parent_seq, ts, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq",
        )
        .all(sessionId, opts2?.sinceSeq ?? 0) as Array<{ seq: number; parent_seq: number | null; ts: string; payload: string }>;
      for (const r of rows) {
        const e: StoredEvent = { seq: r.seq, sessionId, parentSeq: r.parent_seq, ts: r.ts, event: JSON.parse(r.payload) as SessionEvent };
        yield e;
      }
    },
    async head(sessionId) {
      return headOf(sessionId);
    },
    async list(): Promise<SessionInfo[]> {
      const rows = db.prepare("SELECT id, updated FROM sessions ORDER BY updated DESC").all() as Array<{ id: string; updated: string }>;
      return rows.map((r) => ({ id: r.id, mtime: Date.parse(r.updated) }));
    },
    async delete(sessionId) {
      db.prepare("DELETE FROM events WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    },
    async truncate(sessionId, toSeq) {
      truncateTxn.immediate(sessionId, toSeq);
    },
    close() {
      db.close();
    },
  };
}
