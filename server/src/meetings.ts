// 회의실: 안건 → ① 조사(참석자마다, 읽기 전용 도구) → ② 토론(라운드마다 차례로, 도구 없음) → ③ 회의록(서기, 구조화 출력)
// → 회의록 파일 + 할 일은 칸반 초안. 아침 스탠드업은 할 일을 "오늘 할 일" 묶음으로 결재함에 올린다.
// 회의는 파일을 바꾸지 않는다: 조사는 읽기 전용 도구만, 토론·회의록은 도구 없이 답만 한다.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FloorConfig, MyOfficeConfig, TeamConfig } from '../../shared/src/config.ts';
import type { Worker } from '../../shared/src/events.ts';
import {
  MEETING_ACTIVE, MEETING_KIND_LABEL, type ActionItem, type AttendeeInput, type Meeting, type MeetingAttendee, type MeetingKind,
  type MeetingLine, type MeetingStage, type MeetingStatus, type Minutes,
} from '../../shared/src/meetings.ts';
import type { Task } from '../../shared/src/tasks.ts';
import { realGit, type GitFacts, type GitReader } from './gitinfo.ts';
import { READ_ONLY_TOOLS, type OneShot } from './oneshot.ts';
import { SCRIBE, loadPersonas, type PersonaFull } from './personas.ts';
import { TaskError, type TaskManager } from './tasks.ts';

type Row = Record<string, unknown>;

const RESEARCH_MS = 8 * 60_000;
const DEBATE_MS = 3 * 60_000;
const MINUTES_MS = 5 * 60_000;
const DIFF_CHARS = 30_000;
const MAX_ITEMS = 8;
const STANDUP_ITEMS = 5;
const DAY = 24 * 60 * 60_000;

const TASK_STATUS_KO: Record<string, string> = {
  draft: '초안', queued: '대기', planning: '계획 중', plan_review: '계획 결재 대기', running: '실행 중', approval: '결재 대기', failed: '실패',
};

/** 이 PC 시간 기준 YYYY-MM-DD */
export function ymd(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const hhmm = (ts: number) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`; };
const clockOf = (ts: number) => { const d = new Date(ts); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

const gistSchema = (field: 'findings' | 'remark') => ({
  type: 'object',
  properties: { gist: { type: 'string' }, [field]: { type: 'string' } },
  required: ['gist', field],
});

export function minutesSchema(teamIds: string[]): object {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      discussion: { type: 'string' },
      decisions: { type: 'array', items: { type: 'string' } },
      actionItems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            teamId: { type: 'string', enum: teamIds },
            agent: { type: ['string', 'null'] },
            title: { type: 'string' },
            instruction: { type: 'string' },
          },
          required: ['teamId', 'agent', 'title', 'instruction'],
        },
      },
      openQuestions: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'discussion', 'decisions', 'actionItems', 'openQuestions'],
  };
}

const COMMON_RULES = [
  '[마이오피스 회의 규칙]',
  '- 회의에서는 파일을 절대 바꾸지 않는다. 조사는 읽기·검색만 한다.',
  '- 한국어로 말한다. 근거가 있으면 파일 경로를 댄다. 모르는 것은 모른다고 한다.',
  '- 짧고 구체적으로. 인사·맺음말은 생략한다.',
].join('\n');

export interface MeetingManagerOptions {
  db: DatabaseSync;
  config: MyOfficeConfig;
  tasks: TaskManager;
  ask: OneShot;
  agentsOf: (teamPath: string) => { name: string; description: string }[];
  notesDir: string;
  git?: GitReader;
  personas?: () => Map<string, PersonaFull>;
  now?: () => number;
  uuid?: () => string;
  /** 회의 목록·상태가 바뀔 때 (화면 갱신) */
  onChange?: () => void;
  /** 발언이 새로 나올 때 */
  onLine?: (line: MeetingLine) => void;
  /** 회의 참석자(3D 직원)가 바뀔 때 */
  onWorkers?: (changed: Worker[], removed: string[]) => void;
  /** 회의가 끝났을 때 (알림) */
  onFinished?: (m: Meeting) => void;
}

interface Current {
  id: number;
  abort: AbortController;
  /** 회의실에 앉아 있는 직원 (참석자 + 서기) */
  room: Map<string, Worker>;
}

interface Speaker {
  index: number | null;
  name: string;
  /** 이 폴더와 같은 층 다른 팀 폴더 안에서만 읽을 수 있다 */
  cwd: string;
  addDirs: string[];
  agent: string | null;
  system: string;
  workerId: string;
}

export class MeetingManager {
  private readonly db: DatabaseSync;
  private readonly config: MyOfficeConfig;
  private readonly tasks: TaskManager;
  private readonly ask: OneShot;
  private readonly agentsOf: MeetingManagerOptions['agentsOf'];
  private readonly notesDir: string;
  private readonly git: GitReader;
  private readonly personas: () => Map<string, PersonaFull>;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly onChange: () => void;
  private readonly onLine: (line: MeetingLine) => void;
  private readonly onWorkers: (changed: Worker[], removed: string[]) => void;
  private readonly onFinished: (m: Meeting) => void;
  private current: Current | null = null;
  /** 회의 호출의 세션 id → 그 호출을 한 직원. 늦게 오는 훅 이벤트도 삼키려고 끝난 뒤에도 잠시 기억한다 */
  private sessions = new Map<string, string>();
  /** git을 읽으며 스탠드업을 준비 중인 층 */
  private preparing = new Set<number>();
  private closed = false;

  constructor(o: MeetingManagerOptions) {
    this.db = o.db;
    this.config = o.config;
    this.tasks = o.tasks;
    this.ask = o.ask;
    this.agentsOf = o.agentsOf;
    this.notesDir = o.notesDir;
    this.git = o.git ?? realGit;
    this.personas = o.personas ?? (() => loadPersonas());
    this.now = o.now ?? Date.now;
    this.uuid = o.uuid ?? randomUUID;
    this.onChange = o.onChange ?? (() => {});
    this.onLine = o.onLine ?? (() => {});
    this.onWorkers = o.onWorkers ?? (() => {});
    this.onFinished = o.onFinished ?? (() => {});
    this.recover();
  }

  // ───────── 조회 ─────────

  list(limit = 40): Meeting[] {
    return (this.db.prepare('SELECT * FROM meetings ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(r => this.toMeeting(r));
  }

  get(id: number): Meeting {
    const r = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new TaskError('없는 회의입니다');
    return this.toMeeting(r);
  }

  lines(id: number): MeetingLine[] {
    return (this.db.prepare('SELECT * FROM meeting_lines WHERE meeting_id = ? ORDER BY id').all(id) as Row[]).map(toLine);
  }

  personaList() {
    return [...this.personas().values()].filter(p => p.id !== SCRIBE).map(({ body: _, ...p }) => p);
  }

  /** 마지막으로 이 층 스탠드업이 끝난 시각 */
  lastStandupAt(floor: number): number | null {
    const v = this.meta(`standup_at:${floor}`);
    return v ? Number(v) : null;
  }

  // ───────── 열기 · 중지 ─────────

  open(input: { kind: MeetingKind; floor: number; title?: string; agenda: string; attendees: AttendeeInput[]; rounds?: number }, o: { routineDate?: string | null } = {}): Meeting {
    const kind = input.kind;
    if (!['planning', 'review', 'standup'].includes(kind)) throw new TaskError('회의 종류는 planning · review · standup');
    const floor = this.floor(input.floor);
    const agenda = typeof input.agenda === 'string' ? input.agenda.trim() : '';
    if (!agenda) throw new TaskError('안건이 비어 있습니다');
    if (!Array.isArray(input.attendees)) throw new TaskError('참석자 목록이 잘못됐습니다');
    const attendees = this.resolveAttendees(floor, input.attendees);
    const asked = Number(input.rounds);
    const rounds = kind === 'standup' ? 0
      : Math.max(0, Math.min(3, Math.round(input.rounds != null && Number.isFinite(asked) ? asked : (kind === 'review' ? 1 : this.config.meetings.defaultRounds))));
    const title = input.title?.trim() || agenda.split('\n')[0].slice(0, 30);
    const t = this.now();
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO meetings (kind, floor, title, agenda, attendees, rounds, status, routine_date, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
      .run(kind, floor.floor, title, agenda, '[]', rounds, o.routineDate ?? null, t, t);
    const id = Number(lastInsertRowid);
    // 3D 직원 id는 회의 id가 정해진 뒤에
    const withIds = attendees.map((a, i) => ({ ...a, workerId: `meeting-${id}-${i}` }));
    this.db.prepare('UPDATE meetings SET attendees = ? WHERE id = ?').run(JSON.stringify(withIds), id);
    this.addLine(id, 'system', null, null, null, `회의 소집: ${withIds.map(a => a.name).join(', ')}`);
    this.onChange();
    setImmediate(() => this.pump());
    return this.get(id);
  }

  /**
   * 층 아침 스탠드업. 지난 스탠드업 이후 바뀐 것도 없고 남은 일도 없으면 건너뛴다 (force면 무조건 연다).
   * 바뀐 팀(또는 남은 일이 있는 팀)의 대표만 참석한다.
   */
  async openStandup(floorNo: number, o: { routineDate?: string | null; force?: boolean } = {}): Promise<Meeting> {
    const floor = this.floor(floorNo);
    // 확인과 열기 사이에 git을 읽느라 기다리므로, 그동안 같은 층을 또 열지 못하게 먼저 잡아 둔다
    if (this.preparing.has(floorNo) || this.list(100).some(m => m.kind === 'standup' && m.floor === floorNo && MEETING_ACTIVE.includes(m.status))) {
      throw new TaskError(`${floor.label} 스탠드업이 이미 진행 중입니다`);
    }
    this.preparing.add(floorNo);
    try {
      return await this.prepareStandup(floor, o);
    } finally {
      this.preparing.delete(floorNo);
    }
  }

  private async prepareStandup(floor: FloorConfig, o: { routineDate?: string | null; force?: boolean }): Promise<Meeting> {
    const floorNo = floor.floor;
    const since = this.lastStandupAt(floorNo) ?? this.now() - DAY;
    const facts = await this.teamFacts(floor, since);
    // 회의에서 나와 아직 고르지 않은 초안은 "남은 일"로 치지 않는다 (안 그러면 매일 같은 회의를 다시 함)
    const open = this.tasks.openTasks(floorNo).filter(t => !(t.source === 'meeting' && t.status === 'draft'));
    const busy = floor.teams.filter(t => facts.get(t.id)!.fingerprint !== this.meta(`standup_fp:${t.id}`) || open.some(x => x.teamId === t.id));
    const date = ymd(this.now());
    if (!busy.length && !o.force) {
      const t = this.now();
      const { lastInsertRowid } = this.db
        .prepare(`INSERT INTO meetings (kind, floor, title, agenda, attendees, rounds, status, routine_date, created_at, updated_at, ended_at)
                  VALUES ('standup', ?, '아침 스탠드업', ?, '[]', 0, 'skipped', ?, ?, ?, ?)`)
        .run(floorNo, `${clockOf(since)} 이후 바뀐 것도, 남은 할 일도 없어서 건너뜀`, o.routineDate ?? null, t, t, t);
      this.onChange();
      return this.get(Number(lastInsertRowid));
    }
    const teams = (busy.length ? busy : floor.teams).slice(0, this.config.meetings.maxAttendees);
    return this.open({
      kind: 'standup', floor: floorNo, title: '아침 스탠드업',
      agenda: `${date} ${floor.label} ${floor.name} 아침 스탠드업 — ${clockOf(since)} 이후 바뀐 것과 남은 할 일을 보고, 오늘 할 일을 정한다.`,
      attendees: teams.map(t => ({ kind: 'team', teamId: t.id })),
    }, { routineDate: o.routineDate });
  }

  stop(id: number): Meeting {
    const m = this.get(id);
    if (this.current?.id === id) {
      this.current.abort.abort();
    } else if (m.status === 'queued') {
      this.finish(id, 'stopped', { error: '대표가 중지했습니다' });
    }
    return this.get(id);
  }

  /** 서버 종료 시 */
  shutdown(): void {
    this.closed = true;
    this.current?.abort.abort();
  }

  /** 회의 호출의 훅 이벤트면 회의실 직원 말풍선에 반영하고 true (사무실 직원·DB·알림으로는 보내지 않는다) */
  claimHook(sessionId: string, kind: string, tool: string | null, summary: string): boolean {
    const workerId = this.sessions.get(sessionId);
    if (!workerId) return false;
    const w = this.current?.room.get(workerId);
    if (w && kind === 'tool.start' && tool && tool !== 'StructuredOutput') this.updateWorker(w, { summary: `🔎 ${summary}` });
    return true;
  }

  // ───────── 진행 ─────────

  private pump(): void {
    if (this.current || this.closed) return;
    const next = this.db.prepare("SELECT id FROM meetings WHERE status = 'queued' ORDER BY id LIMIT 1").get() as Row | undefined;
    if (!next) return;
    const id = Number(next.id);
    this.current = { id, abort: new AbortController(), room: new Map() };
    this.run(id).catch(() => {}).finally(() => {
      this.leaveRoom();
      this.current = null;
      this.pump();
    });
  }

  private async run(id: number): Promise<void> {
    const cur = this.current!;
    const m = this.get(id);
    const floor = this.floor(m.floor);
    const speakers = this.speakers(m, floor);
    const scribe = this.scribeSpeaker(m, floor);
    this.enterRoom(m, [...speakers, scribe]);
    try {
      // ① 조사
      this.setStatus(id, 'research');
      const ctx = await this.context(m, floor);
      const research = await Promise.all(speakers.map(async (s, i) => {
        const r = await this.call(cur, s, 'research', null, this.researchPrompt(m, floor, s, ctx.brief), gistSchema('findings'), RESEARCH_MS, '조사 중');
        if (!r) return null;
        const { gist, findings } = r as { gist: string; findings: string };
        this.addLine(id, 'research', null, i, gist, findings);
        return { name: s.name, findings };
      }));
      if (research.every(r => !r)) throw new Error('참석자 전원의 조사가 실패했습니다');
      const researchText = research.map((r, i) => `■ ${speakers[i].name}\n${r ? r.findings : '(조사 실패)'}`).join('\n\n');

      // ② 토론
      if (m.rounds > 0) {
        this.setStatus(id, 'debate');
        for (let round = 1; round <= m.rounds; round++) {
          for (let i = 0; i < speakers.length; i++) {
            this.check(cur);
            const r = await this.call(cur, speakers[i], 'debate', round, this.debatePrompt(m, floor, speakers[i], researchText, round), gistSchema('remark'), DEBATE_MS, '발언 준비 중…');
            if (r) {
              const { gist, remark } = r as { gist: string; remark: string };
              this.addLine(id, 'debate', round, i, gist, remark);
            }
          }
        }
      }

      // ③ 회의록
      this.check(cur);
      this.setStatus(id, 'minutes');
      const open = m.kind === 'standup' ? this.tasks.openTasks(m.floor) : [];
      const raw = await this.call(cur, scribe, 'minutes', null, this.minutesPrompt(m, floor, researchText, open), minutesSchema(floor.teams.map(t => t.id)), MINUTES_MS, '회의록 정리 중');
      if (!raw) throw new Error('서기가 회의록을 정리하지 못했습니다');
      const minutes = this.cleanMinutes(raw as Minutes, floor, m.kind === 'standup' ? STANDUP_ITEMS : MAX_ITEMS);

      // 할 일 → 칸반 초안
      const taskIds: number[] = [];
      for (const item of minutes.actionItems) {
        const input = { instruction: item.instruction, teamId: item.teamId, title: item.title, source: 'meeting' as const, draft: true, meetingId: id };
        let task: Task;
        try { task = this.tasks.create({ ...input, agent: item.agent }); } catch { task = this.tasks.create({ ...input, agent: null }); }
        taskIds.push(task.id);
      }
      this.addLine(id, 'minutes', null, null, minutes.summary, `결정 ${minutes.decisions.length}건 · 할 일 ${minutes.actionItems.length}건 · 미결 ${minutes.openQuestions.length}건`);
      this.db.prepare('UPDATE meetings SET minutes = ? WHERE id = ?').run(JSON.stringify(minutes), id);

      if (m.kind === 'standup') {
        // 다음 스탠드업은 이번 회의를 시작한 시각 이후의 커밋을 본다 (회의 중에 들어온 커밋도 빠지지 않게)
        this.meta(`standup_at:${m.floor}`, String(m.createdAt));
        for (const [teamId, fp] of ctx.fingerprints) this.meta(`standup_fp:${teamId}`, fp);
        this.raiseChecklist(m, floor, taskIds);
      }
      this.finish(id, 'done', {});
    } catch (e) {
      // 서버 종료로 멈췄으면 DB가 닫혔을 수 있다 → 다음에 켜질 때 recover가 정리한다
      if (this.closed) return;
      const stopped = cur.abort.signal.aborted;
      this.addLine(id, 'system', null, null, null, stopped ? '회의를 중지했습니다' : `회의 실패: ${(e as Error).message}`);
      this.finish(id, stopped ? 'stopped' : 'failed', { error: stopped ? '중지됨' : (e as Error).message });
    }
  }

  /** 한 번 묻기. 실패하면 발언 기록에 남기고 null */
  private async call(cur: Current, s: Speaker, stage: MeetingStage, round: number | null, prompt: string, schema: object, timeoutMs: number, busy: string): Promise<unknown | null> {
    this.check(cur);
    const sessionId = this.uuid();
    this.remember(sessionId, s.workerId);
    const w = cur.room.get(s.workerId);
    if (w) this.updateWorker(w, { status: 'working', summary: busy });
    try {
      const research = stage === 'research';
      const r = await this.ask({
        cwd: s.cwd, addDirs: research ? s.addDirs : [], prompt, tools: research ? READ_ONLY_TOOLS : [], schema,
        appendSystemPrompt: s.system, agent: s.agent, sessionId, timeoutMs, signal: cur.abort.signal,
      });
      this.db.prepare('UPDATE meetings SET calls = calls + 1, cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?').run(r.costUsd, this.now(), cur.id);
      const gist = (r.structured as { gist?: string })?.gist;
      if (w) this.updateWorker(w, { status: 'idle', summary: gist ? `💬 ${gist}` : '발언 끝' });
      return r.structured;
    } catch (e) {
      this.db.prepare('UPDATE meetings SET calls = calls + 1, updated_at = ? WHERE id = ?').run(this.now(), cur.id);
      if (w) this.updateWorker(w, { status: 'idle', summary: '…' });
      if (cur.abort.signal.aborted) throw e;
      this.addLine(cur.id, 'system', round, s.index, null, `${s.name}: ${stage === 'research' ? '조사' : stage === 'debate' ? '발언' : '정리'} 실패 — ${(e as Error).message}`);
      return null;
    }
  }

  private check(cur: Current): void {
    if (cur.abort.signal.aborted) throw new Error('중지됨');
  }

  // ───────── 프롬프트 ─────────

  private header(m: Meeting, floor: FloorConfig, me: string): string {
    return [
      `회의: ${MEETING_KIND_LABEL[m.kind]} · ${floor.label} ${floor.name}`,
      `제목: ${m.title}`,
      `안건:\n${m.agenda}`,
      `참석자: ${m.attendees.map((a, i) => `${i + 1}) ${a.name}`).join(' · ')}`,
      `너: ${me}`,
    ].join('\n');
  }

  private researchPrompt(m: Meeting, floor: FloorConfig, s: Speaker, brief: string): string {
    return [
      '[마이오피스 회의 — ① 사전 조사]',
      this.header(m, floor, s.name),
      brief && `\n${brief}`,
      '',
      m.kind === 'standup'
        ? '할 일: 위 현황에서 네 팀 부분을 보고, 필요한 만큼 코드·문서를 읽어 무엇이 진행 중인지, 오늘 해야 할 일이 무엇인지 파악해라. 문서의 TODO도 확인해라.'
        : m.kind === 'review'
          ? '할 일: 위 변경 내용을 네 관점에서 검토해라. 필요하면 관련 코드를 더 읽어라. 문제는 위험도(높음/중간/낮음)와 파일 위치를 붙여라.'
          : '할 일: 이 안건을 네 관점에서 판단하는 데 필요한 사실을 조사해라.',
      '- 쓸 수 있는 도구는 파일 읽기·검색·웹 검색뿐이다. 파일을 바꾸지 않는다. 조사는 꼭 필요한 만큼만 (파일 10개 안쪽).',
      '- findings: 조사한 사실과 네 의견. 한국어 불릿, 근거 파일 경로 포함, 1500자 이내.',
      '- gist: 말풍선에 띄울 한 줄 요지 (30자 이내).',
    ].filter(x => x !== '').join('\n');
  }

  private debatePrompt(m: Meeting, floor: FloorConfig, s: Speaker, researchText: string, round: number): string {
    const said = this.lines(m.id).filter(l => l.stage === 'debate')
      .map(l => `(${l.round}라운드) ${m.attendees[l.speaker!]?.name}: ${l.text}`).join('\n\n');
    return [
      `[마이오피스 회의 — ② 토론 ${round}/${m.rounds}라운드]`,
      this.header(m, floor, s.name),
      '',
      '[사전 조사]',
      researchText,
      '',
      '[지금까지의 발언]',
      said || '(아직 없음 — 네가 첫 발언이다)',
      '',
      `할 일: 네(${s.name}) 차례다. 앞 발언에 동의하거나 반박하고, 구체적인 제안을 해라.`,
      '- 새 사실을 지어내지 말고 사전 조사와 앞 발언만 근거로 삼는다.',
      round === m.rounds ? '- 마지막 라운드다. 합의할 수 있는 것과 남는 쟁점을 분명히 해라.' : '',
      '- remark: 발언 (600자 이내).',
      '- gist: 말풍선에 띄울 한 줄 요지 (30자 이내).',
    ].filter(x => x !== '').join('\n');
  }

  private minutesPrompt(m: Meeting, floor: FloorConfig, researchText: string, open: Task[]): string {
    const said = this.lines(m.id).filter(l => l.stage === 'debate')
      .map(l => `(${l.round}라운드) ${m.attendees[l.speaker!]?.name}: ${l.text}`).join('\n\n');
    const teams = floor.teams.map(t => {
      const agents = this.agentsOf(t.path).map(a => a.name).join(', ');
      return `- teamId=${t.id} · ${t.name}${agents ? ` · 고정 직원: ${agents}` : ''}`;
    }).join('\n');
    const standup = m.kind === 'standup';
    return [
      '[마이오피스 회의 — ③ 회의록 정리]',
      this.header(m, floor, '서기'),
      '',
      '[사전 조사]',
      researchText,
      ...(said ? ['', '[토론]', said] : []),
      ...(standup ? ['', '[이미 있는 남은 할 일 — 중복으로 만들지 말 것]', open.length ? open.map(t => `- #${t.id} [${TASK_STATUS_KO[t.status] ?? t.status}] ${t.title}`).join('\n') : '(없음)'] : []),
      '',
      '[이 층 팀]',
      teams,
      '',
      '할 일: 회의록을 정리해라.',
      '- summary: 회의 전체 요약 2~3문장.',
      '- discussion: 논의 요지 (한국어 불릿, 800자 이내).',
      '- decisions: 합의된 결정 사항. 합의 안 된 것은 넣지 않는다.',
      standup
        ? `- actionItems: 오늘 할 일 후보. 최대 ${STANDUP_ITEMS}개, 꼭 필요한 것만. 위 "남은 할 일"에 이미 있는 일은 넣지 않는다. 할 게 없으면 빈 배열.`
        : `- actionItems: 회의에서 나온 할 일. 최대 ${MAX_ITEMS}개.`,
      '  teamId는 [이 층 팀]에서 고른다. agent는 그 팀 고정 직원 중 딱 맞는 사람이 있을 때만 이름, 아니면 null.',
      '  title은 20자 안팎. instruction은 담당 팀이 바로 일할 수 있게 구체적으로: 무엇을, 어디서(파일·화면), 완료 기준.',
      '- openQuestions: 대표에게 확인할 것, 합의되지 않은 쟁점.',
    ].join('\n');
  }

  private cleanMinutes(raw: Minutes, floor: FloorConfig, max: number): Minutes {
    const teamIds = new Set(floor.teams.map(t => t.id));
    const strings = (v: unknown) => (Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : []);
    return {
      summary: String(raw.summary ?? '').trim(),
      discussion: String(raw.discussion ?? '').trim(),
      decisions: strings(raw.decisions),
      openQuestions: strings(raw.openQuestions),
      actionItems: (Array.isArray(raw.actionItems) ? raw.actionItems : [])
        .filter((a: ActionItem) => teamIds.has(a.teamId) && String(a.instruction ?? '').trim())
        .slice(0, max)
        .map((a: ActionItem) => ({ teamId: a.teamId, agent: a.agent || null, title: String(a.title ?? '').trim() || String(a.instruction).slice(0, 30), instruction: String(a.instruction).trim() })),
    };
  }

  // ───────── 참석자 · 배경 자료 ─────────

  private resolveAttendees(floor: FloorConfig, input: AttendeeInput[]): Omit<MeetingAttendee, 'workerId'>[] {
    const personas = this.personas();
    const out: Omit<MeetingAttendee, 'workerId'>[] = [];
    const seen = new Set<string>();
    for (const a of input) {
      if (!a || typeof a !== 'object' || !['team', 'agent', 'persona'].includes(a.kind)) throw new TaskError('참석자 목록이 잘못됐습니다');
      const key = JSON.stringify(a);
      if (seen.has(key)) continue;
      seen.add(key);
      if (a.kind === 'persona') {
        const p = personas.get(a.persona);
        if (!p || p.id === SCRIBE) throw new TaskError(`없는 역할입니다: ${a.persona}`);
        out.push({ kind: 'persona', teamId: null, agent: null, persona: p.id, name: `${p.emoji} ${p.name}` });
        continue;
      }
      const team = floor.teams.find(t => t.id === a.teamId);
      if (!team) throw new TaskError(`${floor.label}에 없는 팀입니다: ${a.teamId}`);
      if (a.kind === 'agent') {
        if (!this.agentsOf(team.path).some(x => x.name === a.agent)) throw new TaskError(`${team.name}에 없는 직원입니다: ${a.agent}`);
        out.push({ kind: 'agent', teamId: team.id, agent: a.agent, persona: null, name: `${a.agent} (${team.name})` });
      } else {
        out.push({ kind: 'team', teamId: team.id, agent: null, persona: null, name: `${team.name} 대표` });
      }
    }
    if (!out.length) throw new TaskError('참석자를 한 명 이상 고르세요');
    if (out.length > this.config.meetings.maxAttendees) throw new TaskError(`참석자는 최대 ${this.config.meetings.maxAttendees}명입니다`);
    return out;
  }

  /** 공용 역할이 조사할 폴더: 참석한 첫 팀, 없으면 층의 첫 팀 */
  private homeTeam(m: Meeting, floor: FloorConfig): TeamConfig {
    const id = m.attendees.find(a => a.teamId)?.teamId;
    return floor.teams.find(t => t.id === id) ?? floor.teams[0];
  }

  private speakers(m: Meeting, floor: FloorConfig): Speaker[] {
    const personas = this.personas();
    const home = this.homeTeam(m, floor);
    return m.attendees.map((a, i) => {
      const team = floor.teams.find(t => t.id === a.teamId) ?? home;
      const role = a.kind === 'persona'
        ? personas.get(a.persona!)?.body ?? `너는 ${a.name}이다.`
        : a.kind === 'agent'
          ? `너는 ${floor.label} ${floor.name} ${team.name}의 고정 직원 "${a.agent}"로 회의에 참석했다.`
          : `너는 ${floor.label} ${floor.name} ${team.name}의 대표다. 지금 폴더(${team.path})의 코드와 문서를 가장 잘 안다. 이 팀 입장에서 말한다.`;
      return { index: i, name: a.name, cwd: team.path, addDirs: otherTeams(floor, team), agent: a.agent, system: `${role}\n\n${COMMON_RULES}`, workerId: a.workerId };
    });
  }

  private scribeSpeaker(m: Meeting, floor: FloorConfig): Speaker {
    const body = this.personas().get(SCRIBE)?.body ?? '너는 회의 서기다. 발언에 없는 내용을 지어내지 않는다.';
    return { index: null, name: '📝 서기', cwd: this.homeTeam(m, floor).path, addDirs: [], agent: null, system: `${body}\n\n${COMMON_RULES}`, workerId: `meeting-${m.id}-scribe` };
  }

  private async teamFacts(floor: FloorConfig, since: number): Promise<Map<string, GitFacts>> {
    const entries = await Promise.all(floor.teams.map(async t => [t.id, await this.git.facts(t.path, since).catch((): GitFacts => (
      { ok: false, head: null, commits: [], changes: [], diffStat: '', fingerprint: 'error' }
    ))] as const));
    return new Map(entries);
  }

  /** 모든 참석자에게 주는 배경 자료. 스탠드업: 팀별 git 현황·남은 할 일, 코드리뷰: 변경 내용 */
  private async context(m: Meeting, floor: FloorConfig): Promise<{ brief: string; fingerprints: Map<string, string> }> {
    const fingerprints = new Map<string, string>();
    if (m.kind === 'standup') {
      const since = this.lastStandupAt(m.floor) ?? this.now() - DAY;
      const facts = await this.teamFacts(floor, since);
      const open = this.tasks.openTasks(m.floor);
      const parts = floor.teams.map(t => {
        const f = facts.get(t.id)!;
        fingerprints.set(t.id, f.fingerprint);
        const mine = open.filter(x => x.teamId === t.id);
        return [
          `■ ${t.name} (${t.path})`,
          !f.ok ? '- git 저장소가 아님 (변경 이력 없음)'
            : [
              f.commits.length ? `- 새 커밋 ${f.commits.length}건:\n${f.commits.map(c => `  ${c}`).join('\n')}` : '- 새 커밋 없음',
              f.changes.length ? `- 커밋 안 한 변경 ${f.changes.length}건${f.diffStat ? ` (${f.diffStat})` : ''}:\n${f.changes.map(c => `  ${c}`).join('\n')}` : '- 커밋 안 한 변경 없음',
            ].join('\n'),
          mine.length ? `- 남은 할 일:\n${mine.map(x => `  #${x.id} [${TASK_STATUS_KO[x.status] ?? x.status}] ${x.title}`).join('\n')}` : '- 남은 할 일 없음',
        ].join('\n');
      });
      return { brief: `[팀별 현황 — ${clockOf(since)} 이후]\n${parts.join('\n\n')}`, fingerprints };
    }
    if (m.kind === 'review') {
      const targets = [...new Set(m.attendees.map(a => a.teamId).filter((x): x is string => !!x))];
      const teams = targets.length ? floor.teams.filter(t => targets.includes(t.id)) : floor.teams;
      const parts = await Promise.all(teams.map(async t => {
        const d = await this.git.diff(t.path, DIFF_CHARS).catch(() => null);
        return d ? `■ ${t.name} — ${d.label}\n\`\`\`diff\n${d.text}\n\`\`\`` : `■ ${t.name} — 변경 내용 없음`;
      }));
      return { brief: `[검토할 변경 내용]\n${parts.join('\n\n')}`, fingerprints };
    }
    return { brief: '', fingerprints };
  }

  /** 오늘 할 일 → 결재함 묶음 (층마다 하나, 아직 안 고른 지난 항목은 합친다) */
  private raiseChecklist(m: Meeting, floor: FloorConfig, taskIds: number[]): void {
    this.tasks.replaceChecklist(m.id, m.floor, taskIds,
      carried => `${floor.label} ${floor.name} 아침 스탠드업 제안${carried ? ` (지난번에 안 고른 ${carried}건 포함)` : ''}`);
  }

  // ───────── 3D 회의실 ─────────

  private enterRoom(m: Meeting, speakers: Speaker[]): void {
    const cur = this.current!;
    const personas = this.personas();
    const t = this.now();
    for (const s of speakers) {
      const a = s.index === null ? null : m.attendees[s.index];
      const label = !a ? '📝서기'
        : a.kind === 'persona' ? `${personas.get(a.persona!)?.emoji ?? ''}${personas.get(a.persona!)?.name ?? a.name}`
          : a.kind === 'agent' ? a.agent! : undefined;
      cur.room.set(s.workerId, {
        id: s.workerId, sessionId: s.workerId, agentId: 'meeting', agentType: null, label, meetingId: m.id,
        floor: m.floor, teamId: a?.teamId ?? 'hot', status: 'idle', zone: 'meeting', summary: '회의 참석',
        tool: null, startedAt: t, lastSeen: t, toolCount: 0,
      });
    }
    this.onWorkers([...cur.room.values()], []);
  }

  private leaveRoom(): void {
    const cur = this.current;
    if (!cur?.room.size) return;
    const ids = [...cur.room.keys()];
    cur.room.clear();
    this.onWorkers([], ids);
  }

  private updateWorker(w: Worker, patch: Partial<Worker>): void {
    // 회의가 끝나 회의실을 비운 뒤 늦게 끝난 호출이 직원을 다시 들여보내지 않게
    if (this.current?.room.get(w.id) !== w) return;
    Object.assign(w, patch, { lastSeen: this.now() });
    this.onWorkers([w], []);
  }

  private remember(sessionId: string, workerId: string): void {
    this.sessions.set(sessionId, workerId);
    if (this.sessions.size > 300) this.sessions.delete(this.sessions.keys().next().value!);
  }

  // ───────── 저장 ─────────

  private setStatus(id: number, status: MeetingStatus): void {
    this.db.prepare('UPDATE meetings SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now(), id);
    this.onChange();
  }

  private finish(id: number, status: MeetingStatus, o: { error?: string }): void {
    const t = this.now();
    this.db.prepare('UPDATE meetings SET status = ?, error = ?, updated_at = ?, ended_at = ? WHERE id = ?').run(status, o.error ?? null, t, t, id);
    if (status === 'done' || status === 'failed') this.writeNotes(id);
    this.onChange();
    if (status !== 'stopped') this.onFinished(this.get(id));
  }

  private addLine(meetingId: number, stage: MeetingStage, round: number | null, speaker: number | null, gist: string | null, text: string): void {
    const ts = this.now();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO meeting_lines (meeting_id, ts, stage, round, speaker, gist, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(meetingId, ts, stage, round, speaker, gist?.slice(0, 200) ?? null, text.slice(0, 8000));
    this.db.prepare('UPDATE meetings SET updated_at = ? WHERE id = ?').run(ts, meetingId);
    this.onLine({ id: Number(lastInsertRowid), meetingId, ts, stage, round, speaker, gist, text: text.slice(0, 8000) });
  }

  private meta(key: string, value?: string): string | undefined {
    if (value !== undefined) {
      this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
      return value;
    }
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined)?.value as string | undefined;
  }

  private floor(n: number): FloorConfig {
    const f = this.config.floors.find(x => x.floor === Number(n));
    if (!f) throw new TaskError(`없는 층입니다: ${n}`);
    return f;
  }

  private toMeeting(r: Row): Meeting {
    const id = Number(r.id);
    return {
      id,
      kind: r.kind as MeetingKind,
      floor: Number(r.floor),
      title: String(r.title),
      agenda: String(r.agenda),
      attendees: JSON.parse(String(r.attendees)),
      rounds: Number(r.rounds),
      status: r.status as MeetingStatus,
      minutes: r.minutes ? JSON.parse(String(r.minutes)) : null,
      file: (r.file as string) ?? null,
      error: (r.error as string) ?? null,
      costUsd: Number(r.cost_usd ?? 0),
      calls: Number(r.calls ?? 0),
      routineDate: (r.routine_date as string) ?? null,
      taskIds: (this.db.prepare('SELECT id FROM tasks WHERE meeting_id = ? ORDER BY id').all(id) as Row[]).map(x => Number(x.id)),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      endedAt: r.ended_at == null ? null : Number(r.ended_at),
    };
  }

  /** 서버가 다시 켜졌을 때: 진행 중이던 회의는 중단 처리. 대기 중이던 회의는 다시 진행하되, 지난날 아침 루틴 것은 버린다 */
  private recover(): void {
    const t = this.now();
    this.db.prepare(`UPDATE meetings SET status = 'stopped', error = '서버가 다시 시작되어 중단됐습니다', updated_at = ?, ended_at = ?
                     WHERE status IN ('research', 'debate', 'minutes')`).run(t, t);
    this.db.prepare(`UPDATE meetings SET status = 'stopped', error = '지난 아침 루틴이라 열지 않았습니다', updated_at = ?, ended_at = ?
                     WHERE status = 'queued' AND routine_date IS NOT NULL AND routine_date != ?`).run(t, t, ymd(t));
    setImmediate(() => this.pump());
  }

  // ───────── 회의록 파일 ─────────

  private writeNotes(id: number): void {
    try {
      const m = this.get(id);
      const floor = this.floor(m.floor);
      mkdirSync(this.notesDir, { recursive: true });
      const safe = m.title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, '').slice(0, 30) || '회의';
      const base = `${ymd(m.createdAt)}_${hhmm(m.createdAt)}_${floor.label}_${safe}`;
      let file = join(this.notesDir, `${base}.md`);
      for (let n = 2; existsSync(file) && m.file !== file; n++) file = join(this.notesDir, `${base}_${n}.md`);
      writeFileSync(file, renderNotes(m, floor, this.lines(id), this.tasksOf(m)), 'utf8');
      this.db.prepare('UPDATE meetings SET file = ? WHERE id = ?').run(file, id);
      this.onChange();
    } catch (e) {
      this.addLine(id, 'system', null, null, null, `회의록 파일 저장 실패: ${(e as Error).message}`);
    }
  }

  private tasksOf(m: Meeting): Task[] {
    return m.taskIds.map(id => this.tasks.get(id));
  }
}

/** 같은 층(같은 회사)의 다른 팀 폴더. 조사 때 같이 읽을 수 있게 한다 */
const otherTeams = (floor: FloorConfig, team: TeamConfig) => floor.teams.filter(t => t.id !== team.id).map(t => t.path);

const toLine = (r: Row): MeetingLine => ({
  id: Number(r.id),
  meetingId: Number(r.meeting_id),
  ts: Number(r.ts),
  stage: r.stage as MeetingStage,
  round: r.round == null ? null : Number(r.round),
  speaker: r.speaker == null ? null : Number(r.speaker),
  gist: (r.gist as string) ?? null,
  text: String(r.text),
});

const time = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

export function renderNotes(m: Meeting, floor: FloorConfig, lines: MeetingLine[], tasks: Task[]): string {
  const who = (l: MeetingLine) => (l.speaker === null ? '진행' : m.attendees[l.speaker]?.name ?? `참석자 ${l.speaker + 1}`);
  const team = (id: string) => floor.teams.find(t => t.id === id)?.name ?? id;
  const mi = m.minutes;
  const bullets = (xs: string[]) => (xs.length ? xs.map(x => `- ${x}`).join('\n') : '- (없음)');
  const out = [
    `# ${MEETING_KIND_LABEL[m.kind]} — ${m.title}`,
    '',
    `- 일시: ${ymd(m.createdAt)} (${WEEKDAY[new Date(m.createdAt).getDay()]}) ${time(m.createdAt)}${m.endedAt ? ` ~ ${time(m.endedAt)}` : ''}`,
    `- 층: ${floor.label} ${floor.name}`,
    `- 참석: ${m.attendees.map(a => a.name).join(', ')} · 📝 서기`,
    `- 상태: ${m.status === 'done' ? '완료' : m.status === 'failed' ? `실패 — ${m.error}` : m.status}`,
    `- 사용량: Claude 호출 ${m.calls}회 · 추정 $${m.costUsd.toFixed(2)} (구독 한도에서 차감)`,
    '',
    '## 안건',
    m.agenda,
    '',
  ];
  if (mi) {
    out.push(
      '## 요약', mi.summary, '',
      '## 결정 사항', bullets(mi.decisions), '',
      '## 할 일',
      tasks.length
        ? ['| # | 담당 | 할 일 | 상태 |', '|---|---|---|---|', ...tasks.map(t => `| ${t.id} | ${team(t.teamId)}${t.agent ? ` · ${t.agent}` : ''} | **${t.title}** — ${t.instruction.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/')} | ${t.status === 'draft' ? '초안 (칸반)' : t.status} |`)].join('\n')
        : '- (없음)',
      '',
      '## 미결 사항', bullets(mi.openQuestions), '',
      '## 논의 요지', mi.discussion || '- (없음)', '',
    );
  }
  const research = lines.filter(l => l.stage === 'research');
  if (research.length) {
    out.push('## 조사', '');
    for (const l of research) out.push(`### ${who(l)}`, l.text, '');
  }
  const debate = lines.filter(l => l.stage === 'debate');
  if (debate.length) {
    out.push('## 토론 전문', '');
    for (let r = 1; r <= m.rounds; r++) {
      const these = debate.filter(l => l.round === r);
      if (!these.length) continue;
      out.push(`### ${r}라운드`, '');
      for (const l of these) out.push(`**${who(l)}** — ${l.text}`, '');
    }
  }
  const sys = lines.filter(l => l.stage === 'system');
  if (sys.length) out.push('## 진행 기록', ...sys.map(l => `- ${time(l.ts)} ${l.text}`), '');
  return out.join('\n');
}
