// 마이오피스가 직접 시키는 일: 지시 → 계획(계획 모드) → 계획 결재 → 실행(자동 모드) → 완료 보고.
// 실행 중 금지 목록·자동 모드 판단으로 결재가 필요하면 결재함으로 올린다.
import type { DatabaseSync } from 'node:sqlite';
import type { MyOfficeConfig, TeamConfig } from '../../shared/src/config.ts';
import {
  ACTIVE_STATUSES, type Approval, type Task, type TaskLogEntry, type TaskSource, type TaskStatus, type TerminalApprovalMode, type TodayChecklist,
} from '../../shared/src/tasks.ts';
import { listAgents } from './agents.ts';
import { toolSummary } from './normalize.ts';
import { ClaudeProcess, resolveClaude, type PermissionResult, type Spawner } from './runner.ts';

type Row = Record<string, unknown>;

const PLAN_GUIDE = [
  '',
  '---',
  '[마이오피스 진행 방식]',
  '1. 먼저 필요한 것을 조사하고, 무엇을 어떻게 바꿀지 간결한 한국어 계획을 세워 ExitPlanMode로 제출하세요. 대표가 계획을 승인해야 실행됩니다.',
  '2. 승인되면 계획대로 실행하고, 끝나면 한 일·바뀐 파일·확인 결과를 한국어로 짧게 보고하세요.',
].join('\n');

const toTask = (r: Row, live: boolean): Task => ({
  id: Number(r.id),
  title: String(r.title),
  instruction: String(r.instruction),
  floor: Number(r.floor),
  teamId: String(r.team_id),
  agent: (r.agent as string) ?? null,
  source: r.source as TaskSource,
  status: r.status as TaskStatus,
  sessionId: (r.session_id as string) ?? null,
  plan: (r.plan as string) ?? null,
  result: (r.result as string) ?? null,
  error: (r.error as string) ?? null,
  costUsd: Number(r.cost_usd ?? 0),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  live,
  meetingId: r.meeting_id == null ? null : Number(r.meeting_id),
});

const toApproval = (r: Row): Approval => ({
  id: Number(r.id),
  taskId: r.task_id == null ? null : Number(r.task_id),
  kind: r.kind as Approval['kind'],
  sessionId: (r.session_id as string) ?? null,
  toolName: (r.tool_name as string) ?? null,
  input: r.input ? JSON.parse(String(r.input)) : null,
  reason: (r.reason as string) ?? null,
  status: r.status as Approval['status'],
  note: (r.note as string) ?? null,
  createdAt: Number(r.created_at),
  decidedAt: r.decided_at == null ? null : Number(r.decided_at),
});

export class TaskError extends Error {}

export interface TaskManagerOptions {
  db: DatabaseSync;
  config: MyOfficeConfig;
  spawner?: Spawner;
  now?: () => number;
  /** 업무·결재가 바뀔 때 (화면 갱신) */
  onChange?: () => void;
  /** 결재가 새로 필요할 때 (알림). 업무에 딸리지 않은 결재(오늘 할 일 묶음)는 t가 null */
  onApproval?: (a: Approval, t: Task | null) => void;
  /** 고정 직원 목록 (테스트에서 바꿔 끼움) */
  agentsOf?: (teamPath: string) => { name: string }[];
}

interface Live {
  proc: ClaudeProcess;
  /** 이 프로세스를 시작할 때까지의 누적 사용량 (Claude는 프로세스별 누적값을 알려준다) */
  costBase: number;
  idle?: ReturnType<typeof setTimeout>;
  stopping?: boolean;
}

interface PendingApproval {
  taskId: number;
  requestId: string;
  kind: Approval['kind'];
  input: Record<string, unknown>;
}

/** Paseo·터미널 세션의 권한 요청을 결재함에서 받을 때 */
export interface TerminalDecision {
  approve: boolean;
  note: string;
}

export class TaskManager {
  private readonly db: DatabaseSync;
  private readonly config: MyOfficeConfig;
  private readonly spawner?: Spawner;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly onApproval: (a: Approval, t: Task | null) => void;
  private readonly agentsOf: (teamPath: string) => { name: string }[];
  private live = new Map<number, Live>();
  private pending = new Map<number, PendingApproval>();
  private terminalPending = new Map<number, (d: TerminalDecision | null) => void>();

  constructor(o: TaskManagerOptions) {
    this.db = o.db;
    this.config = o.config;
    this.spawner = o.spawner;
    this.now = o.now ?? Date.now;
    this.onChange = o.onChange ?? (() => {});
    this.onApproval = o.onApproval ?? (() => {});
    this.agentsOf = o.agentsOf ?? listAgents;
    this.recover();
  }

  // ───────── 조회 ─────────

  list(): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE archived = 0 ORDER BY updated_at DESC LIMIT 200').all() as Row[];
    return rows.map(r => toTask(r, this.live.has(Number(r.id))));
  }

  get(id: number): Task {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new TaskError('없는 업무입니다');
    return toTask(r, this.live.has(id));
  }

  pendingApprovals(): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all() as Row[]).map(toApproval);
  }

  log(taskId: number): TaskLogEntry[] {
    return (this.db.prepare('SELECT * FROM task_log WHERE task_id = ? ORDER BY id').all(taskId) as Row[]).map(r => ({
      id: Number(r.id), taskId: Number(r.task_id), ts: Number(r.ts), kind: r.kind as TaskLogEntry['kind'], text: String(r.text),
    }));
  }

  /** 이 층에서 아직 끝나지 않은 일 (아침 스탠드업의 "남은 할 일") */
  openTasks(floor: number): Task[] {
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE floor = ? AND archived = 0
      AND status IN ('draft', 'queued', 'planning', 'plan_review', 'running', 'approval', 'failed') ORDER BY created_at`).all(floor) as Row[];
    return rows.map(r => toTask(r, this.live.has(Number(r.id))));
  }

  get running(): number {
    return this.live.size;
  }

  // ───────── 지시 ─────────

  create(input: { instruction: string; teamId: string; agent?: string | null; title?: string; source?: TaskSource; draft?: boolean; meetingId?: number | null }): Task {
    const instruction = input.instruction?.trim();
    if (!instruction) throw new TaskError('지시 내용이 비어 있습니다');
    const { floor, team } = this.team(input.teamId);
    const agent = this.checkAgent(team, input.agent);
    const title = input.title?.trim() || instruction.split('\n')[0].slice(0, 40);
    const t = this.now();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO tasks (title, instruction, floor, team_id, agent, source, status, meeting_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(title, instruction, floor, team.id, agent, input.source ?? 'direct', input.draft ? 'draft' : 'queued', input.meetingId ?? null, t, t);
    const id = Number(lastInsertRowid);
    this.addLog(id, 'instruction', instruction);
    if (!input.draft) this.schedule();
    this.onChange();
    return this.get(id);
  }

  /** 초안(칸반 카드·비서 제안)을 보낸다. 팀·직원·내용을 바꿔서 보낼 수도 있다 */
  start(id: number, patch: { teamId?: string; agent?: string | null; instruction?: string; title?: string } = {}): Task {
    const task = this.get(id);
    if (task.status !== 'draft') throw new TaskError('이미 보낸 업무입니다');
    const { floor, team } = this.team(patch.teamId ?? task.teamId);
    const agent = this.checkAgent(team, patch.agent === undefined ? task.agent : patch.agent);
    this.update(id, {
      floor, team_id: team.id, agent, status: 'queued',
      ...(patch.instruction ? { instruction: patch.instruction } : {}),
      ...(patch.title ? { title: patch.title } : {}),
    });
    this.schedule();
    this.onChange();
    return this.get(id);
  }

  /** 끝난 업무에 이어서 지시. 다시 계획 → 결재 → 실행 */
  message(id: number, text: string): Task {
    const task = this.get(id);
    if (!text.trim()) throw new TaskError('지시 내용이 비어 있습니다');
    if (!['done', 'failed', 'stopped'].includes(task.status)) throw new TaskError('진행 중인 업무에는 끝난 뒤에 이어서 지시할 수 있어요');
    const l = this.live.get(id);
    if (l) {
      this.clearIdle(l);
      l.proc.setPermissionMode('plan');
      l.proc.send(text + PLAN_GUIDE);
    } else {
      if (this.live.size >= this.config.runner.maxConcurrent) throw new TaskError(`동시 실행 상한(${this.config.runner.maxConcurrent}개)에 걸려 있어요. 다른 업무가 끝난 뒤 다시 지시하세요`);
      this.launch(this.get(id), text, task.sessionId);
    }
    this.addLog(id, 'instruction', text);
    this.update(id, { status: 'planning', error: null });
    this.onChange();
    return this.get(id);
  }

  stop(id: number): Task {
    const task = this.get(id);
    const l = this.live.get(id);
    if (l) {
      l.stopping = true;
      l.proc.interrupt();
      setTimeout(() => l.proc.kill(), 2000).unref?.();
    }
    if (['draft', 'queued', ...ACTIVE_STATUSES].includes(task.status)) {
      this.update(id, { status: 'stopped' });
      this.addLog(id, 'system', '대표가 중지했습니다');
    }
    this.cancelApprovals(id);
    this.onChange();
    return this.get(id);
  }

  /** 칸반에서 치우기 (기록은 남는다) */
  archive(id: number): void {
    const task = this.get(id);
    if (this.live.has(id) && ACTIVE_STATUSES.includes(task.status)) throw new TaskError('진행 중인 업무는 먼저 중지하세요');
    this.live.get(id)?.proc.close();
    this.update(id, { archived: 1 });
    this.onChange();
  }

  // ───────── 결재 ─────────

  get terminalMode(): TerminalApprovalMode {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'terminal_approvals'").get() as Row | undefined;
    return r?.value === 'office' ? 'office' : 'terminal';
  }

  set terminalMode(mode: TerminalApprovalMode) {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('terminal_approvals', ?)").run(mode);
    this.onChange();
  }

  /** 마이오피스가 띄운 Claude의 세션인지 (그쪽 결재는 이미 결재함으로 온다) */
  isOfficeSession(sessionId: string): boolean {
    return [...this.live.keys()].some(id => this.get(id).sessionId === sessionId);
  }

  /**
   * Paseo·터미널 세션의 권한 요청을 결재함에 올리고 결정을 기다린다.
   * 시간 안에 결정이 없으면 null → 훅은 빈 응답을 돌려줘서 원래대로 Paseo·터미널에서 묻게 된다.
   */
  waitTerminalApproval(req: { sessionId: string; toolName: string; input: Record<string, unknown>; reason: string | null }, timeoutMs: number): Promise<TerminalDecision | null> {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO approvals (task_id, kind, session_id, tool_name, input, reason, status, created_at)
                VALUES (NULL, 'terminal', ?, ?, ?, ?, 'pending', ?)`)
      .run(req.sessionId, req.toolName, JSON.stringify(req.input ?? {}), req.reason, this.now());
    const id = Number(lastInsertRowid);
    this.onChange();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!this.terminalPending.delete(id)) return;
        this.db.prepare("UPDATE approvals SET status = 'cancelled', note = ?, decided_at = ? WHERE id = ?").run('시간 초과 — Paseo·터미널로 넘김', this.now(), id);
        this.onChange();
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.terminalPending.set(id, d => { clearTimeout(timer); resolve(d); });
    });
  }

  /** 아침 스탠드업이 제안한 "오늘 할 일" 묶음을 결재함에 올린다 (항목은 이미 초안으로 만들어져 있음) */
  createChecklist(list: TodayChecklist, reason: string): Approval {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO approvals (task_id, kind, tool_name, input, reason, status, created_at)
                VALUES (NULL, 'today', NULL, ?, ?, 'pending', ?)`)
      .run(JSON.stringify(list), reason, this.now());
    const a = toApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(lastInsertRowid)) as Row);
    this.onApproval(a, null);
    this.onChange();
    return a;
  }

  /**
   * 층마다 "오늘 할 일" 묶음은 하나: 이 층에 아직 결정 안 한 묶음이 있으면 취소하고,
   * 그 안의 아직 초안인 항목은 새 묶음 앞에 이어 붙인다. 합쳐서 0건이면 새 묶음은 만들지 않는다.
   */
  replaceChecklist(meetingId: number, floor: number, taskIds: number[], reason: (carried: number) => string): Approval | null {
    const carried: TodayChecklist['items'] = [];
    for (const a of this.pendingApprovals().filter(x => x.kind === 'today' && (x.input as unknown as TodayChecklist).floor === floor)) {
      for (const item of (a.input as unknown as TodayChecklist).items) {
        const st = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(item.taskId) as Row | undefined;
        if (st?.status === 'draft') carried.push(item);
      }
      this.db.prepare("UPDATE approvals SET status = 'cancelled', note = '새 아침 스탠드업 묶음으로 합침', decided_at = ? WHERE id = ?").run(this.now(), a.id);
    }
    const fresh = taskIds.map(id => this.get(id)).map(t => ({ taskId: t.id, title: t.title, teamId: t.teamId, agent: t.agent, instruction: t.instruction }));
    const items = [...carried, ...fresh];
    const a = items.length ? this.createChecklist({ meetingId, floor, items }, reason(carried.length)) : null;
    this.onChange();
    return a;
  }

  /** 기다리는 계획 결재를 모두 승인 */
  approveAllPlans(): number {
    const plans = this.pendingApprovals().filter(a => a.kind === 'plan' && this.pending.has(a.id));
    for (const a of plans) this.decide(a.id, true);
    return plans.length;
  }

  /**
   * picks: "오늘 할 일" 묶음에서 고른 업무 id. 고른 것은 보내고(계획 → 계획 결재 → 실행),
   * 안 고른 것은 반려로 치운다 (회의록에는 남아 있음). 생략하면 전부
   */
  decide(approvalId: number, approve: boolean, note = '', picks?: number[]): Approval {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Row | undefined;
    if (!row) throw new TaskError('없는 결재입니다');
    if (row.kind === 'today') return this.decideChecklist(row, approve, note, picks);
    const terminal = this.terminalPending.get(approvalId);
    if (terminal && row.status === 'pending') {
      this.terminalPending.delete(approvalId);
      this.db.prepare('UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', note || null, this.now(), approvalId);
      terminal({ approve, note });
      this.onChange();
      return toApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Row);
    }
    const p = this.pending.get(approvalId);
    if (!p || row.status !== 'pending') throw new TaskError('이미 처리됐거나 취소된 결재입니다');
    const l = this.live.get(p.taskId);
    if (!l) throw new TaskError('이 업무의 Claude가 이미 종료됐습니다');
    this.pending.delete(approvalId);

    let result: PermissionResult;
    if (p.kind === 'plan') {
      result = approve
        ? { behavior: 'allow', updatedInput: p.input, updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }] }
        : { behavior: 'deny', message: `대표가 계획을 반려했습니다.${note ? ` 사유: ${note}.` : ''} 반려 사유를 반영해 계획을 다시 세워 ExitPlanMode로 제출하세요.` };
      this.update(p.taskId, { status: approve ? 'running' : 'planning' });
    } else {
      result = approve
        ? { behavior: 'allow', updatedInput: p.input }
        : { behavior: 'deny', message: `대표가 이 작업을 반려했습니다.${note ? ` 사유: ${note}.` : ''} 다른 방법을 찾거나, 필요하면 사용자가 직접 하도록 안내하세요.` };
      this.update(p.taskId, { status: 'running' });
    }
    l.proc.respond(p.requestId, result);
    this.db.prepare('UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', note || null, this.now(), approvalId);
    this.addLog(p.taskId, 'approval', `${p.kind === 'plan' ? '계획' : '작업'} ${approve ? '승인' : '반려'}${note ? ` — ${note}` : ''}`);
    this.onChange();
    return toApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Row);
  }

  /** 서버 종료 시 */
  shutdown(): void {
    for (const l of this.live.values()) { l.stopping = true; l.proc.kill(); }
    // 기다리던 Paseo·터미널 결재는 원래대로 그쪽에서 묻게 돌려준다
    for (const resolve of this.terminalPending.values()) resolve(null);
    this.terminalPending.clear();
  }

  // ───────── 내부 ─────────

  private decideChecklist(row: Row, approve: boolean, note: string, picks?: number[]): Approval {
    if (row.status !== 'pending') throw new TaskError('이미 처리된 결재입니다');
    const list = JSON.parse(String(row.input)) as TodayChecklist;
    const chosen = new Set(approve ? (picks ?? list.items.map(i => i.taskId)) : []);
    let sent = 0;
    for (const item of list.items) {
      const task = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(item.taskId) as Row | undefined;
      if (task?.status !== 'draft') continue; // 그사이 칸반에서 직접 보냈거나 치운 것
      if (chosen.has(item.taskId)) { this.start(item.taskId); sent++; }
      else {
        this.update(item.taskId, { status: 'rejected', archived: 1 });
        this.addLog(item.taskId, 'system', '오늘 할 일에서 고르지 않음');
      }
    }
    const status = sent ? 'approved' : 'rejected';
    this.db.prepare('UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ?').run(status, note || `${sent}/${list.items.length}건 진행`, this.now(), Number(row.id));
    this.onChange();
    return toApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(row.id)) as Row);
  }

  private team(teamId: string): { floor: number; team: TeamConfig } {
    for (const f of this.config.floors) {
      const team = f.teams.find(t => t.id === teamId);
      if (team) return { floor: f.floor, team };
    }
    throw new TaskError(`없는 팀입니다: ${teamId}`);
  }

  private checkAgent(team: TeamConfig, agent: string | null | undefined): string | null {
    if (!agent) return null;
    if (!this.agentsOf(team.path).some(a => a.name === agent)) throw new TaskError(`${team.name}에 없는 직원입니다: ${agent}`);
    return agent;
  }

  private update(id: number, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE tasks SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...(keys.map(k => fields[k]) as never[]), this.now(), id);
  }

  private addLog(taskId: number, kind: TaskLogEntry['kind'], text: string): void {
    this.db.prepare('INSERT INTO task_log (task_id, ts, kind, text) VALUES (?, ?, ?, ?)').run(taskId, this.now(), kind, text.slice(0, 4000));
  }

  private cancelApprovals(taskId: number): void {
    for (const [id, p] of this.pending) if (p.taskId === taskId) this.pending.delete(id);
    this.db.prepare("UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE task_id = ? AND status = 'pending'").run(this.now(), taskId);
  }

  private clearIdle(l: Live): void {
    if (l.idle) clearTimeout(l.idle);
    l.idle = undefined;
  }

  /** 서버가 다시 켜졌을 때: 이전 프로세스는 이미 없으므로 진행 중이던 업무는 중단 처리 */
  private recover(): void {
    const t = this.now();
    this.db.prepare(`UPDATE tasks SET status = 'stopped', error = '서버가 다시 시작되어 중단됐습니다', updated_at = ?
                     WHERE status IN ('planning', 'plan_review', 'running', 'approval')`).run(t);
    // 오늘 할 일 묶음은 프로세스와 상관없으니 그대로 둔다
    this.db.prepare("UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE status = 'pending' AND kind != 'today'").run(t);
  }

  private schedule(): void {
    const max = this.config.runner.maxConcurrent;
    while (this.live.size < max) {
      const next = this.db.prepare("SELECT * FROM tasks WHERE status = 'queued' AND archived = 0 ORDER BY created_at LIMIT 1").get() as Row | undefined;
      if (!next) break;
      const task = toTask(next, false);
      this.update(task.id, { status: 'planning' });
      this.launch(task, task.instruction, null);
    }
  }

  private launch(task: Task, text: string, resume: string | null): void {
    const { team } = this.team(task.teamId);
    const id = task.id;
    const l: Live = { costBase: task.costUsd } as Live;
    l.proc = new ClaudeProcess(
      {
        exe: resolveClaude(this.config.runner), cwd: team.path, model: this.config.runner.model,
        permissionMode: 'plan', agent: task.agent, resume,
      },
      {
        onInit: sessionId => { this.update(id, { session_id: sessionId }); this.onChange(); },
        onText: s => this.addLog(id, 'text', s),
        onTool: (name, input) => { if (name !== 'ExitPlanMode') this.addLog(id, 'tool', `${name} · ${toolSummary(name, input)}`); },
        onPermission: (requestId, req) => {
          const isPlan = req.tool_name === 'ExitPlanMode';
          const t = this.now();
          const { lastInsertRowid } = this.db
            .prepare(`INSERT INTO approvals (task_id, kind, session_id, request_id, tool_name, input, reason, status, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
            .run(id, isPlan ? 'plan' : 'tool', this.get(id).sessionId, requestId, req.tool_name, JSON.stringify(req.input ?? {}),
              req.decision_reason ?? req.decision_reason_type ?? null, t);
          const approvalId = Number(lastInsertRowid);
          this.pending.set(approvalId, { taskId: id, requestId, kind: isPlan ? 'plan' : 'tool', input: req.input ?? {} });
          if (isPlan) this.update(id, { status: 'plan_review', plan: String(req.input?.plan ?? '') });
          else this.update(id, { status: 'approval' });
          this.addLog(id, 'approval', isPlan ? '계획 결재 요청' : `결재 요청: ${req.tool_name} · ${toolSummary(req.tool_name, req.input ?? {})}`);
          this.onApproval(toApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Row), this.get(id));
          this.onChange();
        },
        onCancel: requestId => {
          for (const [aid, p] of this.pending) {
            if (p.taskId === id && p.requestId === requestId) {
              this.pending.delete(aid);
              this.db.prepare("UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE id = ?").run(this.now(), aid);
            }
          }
          this.onChange();
        },
        onResult: r => {
          const status: TaskStatus = this.get(id).status === 'stopped' ? 'stopped' : r.isError ? 'failed' : 'done';
          this.update(id, { status, result: r.text, cost_usd: l.costBase + r.costUsd, ...(r.isError ? { error: r.text } : {}) });
          this.addLog(id, 'result', r.text || '(보고 없음)');
          // 이어서 지시할 수 있게 잠시 살려 두고, 오래 조용하면 닫는다
          this.clearIdle(l);
          l.idle = setTimeout(() => l.proc.close(), this.config.runner.idleMinutes * 60_000);
          l.idle.unref?.();
          this.onChange();
        },
        onExit: (code, stderr) => {
          this.clearIdle(l);
          this.live.delete(id);
          const cur = this.get(id);
          if (ACTIVE_STATUSES.includes(cur.status) && !l.stopping) {
            this.update(id, { status: 'failed', error: `Claude가 예기치 않게 종료됐습니다 (코드 ${code}). ${stderr.trim().slice(-500)}` });
            this.addLog(id, 'system', `비정상 종료 (코드 ${code})`);
          }
          this.cancelApprovals(id);
          this.schedule();
          this.onChange();
        },
      },
      this.spawner,
    );
    this.live.set(id, l);
    l.proc.send(text + PLAN_GUIDE);
  }
}
