import { DatabaseSync } from 'node:sqlite';
import type { OfficeEvent } from '../../shared/src/events.ts';

// 순서대로 한 번씩 적용된다. 이미 적용된 항목은 고치지 말고 새 항목을 추가할 것.
const MIGRATIONS = [
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     ts INTEGER NOT NULL,
     kind TEXT NOT NULL,
     session_id TEXT NOT NULL,
     agent_id TEXT,
     agent_type TEXT,
     floor INTEGER NOT NULL,
     team_id TEXT NOT NULL,
     cwd TEXT NOT NULL,
     tool TEXT,
     zone TEXT,
     summary TEXT NOT NULL,
     raw TEXT
   );
   CREATE INDEX events_ts ON events(ts);
   CREATE INDEX events_session ON events(session_id, ts);
   CREATE INDEX events_floor ON events(floor, ts);
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     floor INTEGER NOT NULL,
     team_id TEXT NOT NULL,
     cwd TEXT NOT NULL,
     transcript_path TEXT,
     model TEXT,
     started_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     ended_at INTEGER
   );`,
  // 2: Phase 2 — 마이오피스가 시키는 일, 결재, 업무일지
  `CREATE TABLE tasks (
     id INTEGER PRIMARY KEY,
     title TEXT NOT NULL,
     instruction TEXT NOT NULL,
     floor INTEGER NOT NULL,
     team_id TEXT NOT NULL,
     agent TEXT,
     source TEXT NOT NULL,
     status TEXT NOT NULL,
     session_id TEXT,
     plan TEXT,
     result TEXT,
     error TEXT,
     cost_usd REAL NOT NULL DEFAULT 0,
     archived INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX tasks_open ON tasks(archived, updated_at);
   CREATE TABLE approvals (
     id INTEGER PRIMARY KEY,
     task_id INTEGER,
     kind TEXT NOT NULL,
     session_id TEXT,
     request_id TEXT,
     tool_name TEXT,
     input TEXT,
     reason TEXT,
     status TEXT NOT NULL,
     note TEXT,
     created_at INTEGER NOT NULL,
     decided_at INTEGER
   );
   CREATE INDEX approvals_status ON approvals(status, created_at);
   CREATE TABLE task_log (
     id INTEGER PRIMARY KEY,
     task_id INTEGER NOT NULL,
     ts INTEGER NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL
   );
   CREATE INDEX task_log_task ON task_log(task_id, id);`,
];

type Row = Record<string, unknown>;

const toEvent = (r: Row): OfficeEvent => ({
  id: r.id as number,
  ts: r.ts as number,
  kind: r.kind as OfficeEvent['kind'],
  sessionId: r.session_id as string,
  agentId: (r.agent_id as string) ?? null,
  agentType: (r.agent_type as string) ?? null,
  floor: r.floor as number,
  teamId: r.team_id as string,
  cwd: r.cwd as string,
  tool: (r.tool as string) ?? null,
  zone: (r.zone as OfficeEvent['zone']) ?? null,
  summary: r.summary as string,
});

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as Row | undefined;
    for (let v = Number(row?.value ?? 0); v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(v + 1));
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  insertEvent(e: Omit<OfficeEvent, 'id'>, raw: unknown, session: { transcriptPath?: string; model?: string }): OfficeEvent {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO events (ts, kind, session_id, agent_id, agent_type, floor, team_id, cwd, tool, zone, summary, raw)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.ts, e.kind, e.sessionId, e.agentId, e.agentType, e.floor, e.teamId, e.cwd, e.tool, e.zone, e.summary, JSON.stringify(raw));
    this.db
      .prepare(`INSERT INTO sessions (id, floor, team_id, cwd, transcript_path, model, started_at, last_seen, ended_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  last_seen = excluded.last_seen,
                  transcript_path = COALESCE(excluded.transcript_path, transcript_path),
                  model = COALESCE(excluded.model, model),
                  ended_at = COALESCE(excluded.ended_at, ended_at)`)
      .run(e.sessionId, e.floor, e.teamId, e.cwd, session.transcriptPath ?? null, session.model ?? null,
        e.ts, e.ts, e.kind === 'session.end' ? e.ts : null);
    return { ...e, id: Number(lastInsertRowid) };
  }

  recentEvents(limit = 100, floor?: number): OfficeEvent[] {
    const rows = floor === undefined
      ? this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM events WHERE floor = ? ORDER BY id DESC LIMIT ?').all(floor, limit);
    return (rows as Row[]).map(toEvent);
  }

  eventsSince(ts: number): OfficeEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE ts >= ? ORDER BY id').all(ts) as Row[]).map(toEvent);
  }

  /** 이 세션이 마지막으로 지시를 받은 시각 (서버를 재시작해도 작업 시간을 계산할 수 있게) */
  lastPromptAt(sessionId: string): number | undefined {
    const row = this.db.prepare("SELECT MAX(ts) AS ts FROM events WHERE session_id = ? AND kind = 'prompt'").get(sessionId) as Row | undefined;
    return row?.ts == null ? undefined : Number(row.ts);
  }

  countEvents(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as Row).n);
  }

  close(): void {
    this.db.close();
  }
}
