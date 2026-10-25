import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import type { WebSocket } from 'ws';
import type { MyOfficeConfig } from '../../shared/src/config.ts';
import type { OfficeEvent, ServerMessage } from '../../shared/src/events.ts';
import type { Approval, Task, TaskSource } from '../../shared/src/tasks.ts';
import { listAgents } from './agents.ts';
import { ROOT, createTeamMatcher } from './config.ts';
import type { Store } from './db.ts';
import { normalize, shrink, type HookPayload } from './normalize.ts';
import type { Spawner } from './runner.ts';
import { askSecretary, type SecretaryAnswer } from './secretary.ts';
import { createSecurity, type Security } from './security.ts';
import { OfficeState } from './state.ts';
import { TaskError, TaskManager } from './tasks.ts';

const REPLAY_WINDOW = 12 * 60 * 60_000;
/** Paseo·터미널 결재를 결재함에서 기다리는 시간. 넘으면 원래대로 그쪽에서 묻는다 (훅 timeout 300초보다 짧게) */
export const TERMINAL_WAIT_MS = 280_000;

export interface AppOptions {
  config: MyOfficeConfig;
  store: Store;
  token: string;
  now?: () => number;
  /** 이벤트가 저장될 때마다 호출 (서버 로그용) */
  onEvent?: (e: OfficeEvent) => void;
  /** 결재가 새로 필요할 때 (윈도우 알림) */
  onApproval?: (a: Approval, t: Task) => void;
  /** 빌드된 화면(web/dist). 있으면 / 에서 서빙 */
  webRoot?: string;
  security?: Security;
  /** 테스트용: 진짜 claude.exe 대신 가짜 프로세스 */
  spawner?: Spawner;
  agentsOf?: (teamPath: string) => { name: string; description: string }[];
  secretary?: (text: string) => Promise<SecretaryAnswer>;
}

/** `npm run demo`가 보내는 가짜 세션. 화면에는 보이지만 DB에는 남기지 않는다 */
export const isDemoSession = (sessionId: string) => sessionId.startsWith('demo-');

export async function buildApp(o: AppOptions) {
  const { config, store, token, now = Date.now, onEvent, webRoot } = o;
  const security = o.security ?? createSecurity();
  const agentsOf = o.agentsOf ?? ((p: string) => listAgents(p));
  const secretary = o.secretary ?? ((text: string) => askSecretary(config, agentsOf, text, ROOT));

  // Read 결과처럼 큰 페이로드도 받아야 한다. 거절하면 그 이벤트를 잃는다.
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  app.addHook('onRequest', security.check);
  await app.register(websocket);
  if (webRoot && existsSync(webRoot)) await app.register(fastifyStatic, { root: webRoot });
  let demoId = 0;

  const matchTeam = createTeamMatcher(config);
  const office = new OfficeState(config.floors);
  for (const e of store.eventsSince(now() - REPLAY_WINDOW)) office.apply(e);
  office.tick(now());

  const clients = new Set<WebSocket>();
  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) ws.send(data);
  };

  // 업무·결재가 바뀌면 화면에 보낸다 (한 번에 여러 번 바뀌어도 한 번만)
  let workQueued = false;
  let closing = false;
  const tasks: TaskManager = new TaskManager({
    db: store.db, config, now, spawner: o.spawner, agentsOf,
    onApproval: o.onApproval,
    onChange: () => {
      if (workQueued || closing) return;
      workQueued = true;
      setImmediate(() => {
        workQueued = false;
        if (!closing) broadcast({ type: 'work', tasks: tasks.list(), approvals: tasks.pendingApprovals(), terminalMode: tasks.terminalMode });
      });
    },
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof TaskError) return reply.code(400).send({ error: err.message });
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  app.post('/hook', async (req, reply) => {
    if (req.headers['x-myoffice-token'] !== token) return reply.code(401).send();
    const p = (req.body ?? {}) as HookPayload;
    const norm = normalize(p);
    const match = p.cwd ? matchTeam(p.cwd) : null;
    // 등록되지 않은 폴더의 이벤트는 저장하지 않는다
    if (!norm || !match || !p.session_id) return reply.code(204).send();

    const base = {
      ts: now(), kind: norm.kind, sessionId: p.session_id,
      agentId: p.agent_id ?? null, agentType: p.agent_type ?? null,
      floor: match.floor.floor, teamId: match.team.id, cwd: p.cwd!,
      tool: norm.tool, zone: norm.zone, summary: norm.summary,
    };
    const event = isDemoSession(p.session_id)
      ? { ...base, id: --demoId }
      : store.insertEvent(base, shrink(p), { transcriptPath: p.transcript_path as string | undefined, model: p.model as string | undefined });
    const { changed, removed } = office.apply(event);
    broadcast({ type: 'event', event, changed, removed, floors: office.floorSummaries() });
    onEvent?.(event);

    // 토글을 켰으면 Paseo·터미널 세션의 권한 요청을 결재함에서 받는다 (마이오피스가 시킨 일은 이미 결재함으로 옴)
    if (norm.kind === 'permission.request' && tasks.terminalMode === 'office' && !isDemoSession(p.session_id) && !tasks.isOfficeSession(p.session_id)) {
      const d = await tasks.waitTerminalApproval(
        { sessionId: p.session_id, toolName: p.tool_name ?? '', input: p.tool_input ?? {}, reason: null },
        TERMINAL_WAIT_MS,
      );
      if (d) {
        const decision = d.approve
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: `대표가 마이오피스 결재함에서 반려했습니다.${d.note ? ` 사유: ${d.note}` : ''}` };
        return reply.code(200).send({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
      }
    }
    // 빈 2xx = "아무 결정도 하지 않음". Claude Code는 평소대로 진행한다
    return reply.code(204).send();
  });

  app.get('/health', async () => ({ ok: true, events: store.countEvents(), workers: office.workers.size, running: tasks.running }));

  /** 화면이 처음 열릴 때 키를 받아 간다. 다른 사이트는 이 응답을 읽을 수 없다 */
  app.get('/api/session', async () => ({ key: security.uiKey }));

  app.get('/api/config', async () => ({
    defaultFloor: config.defaultFloor,
    floors: config.floors,
    maxConcurrent: config.runner.maxConcurrent,
  }));

  app.get('/api/state', async () => ({ workers: office.list(), floors: office.floorSummaries() }));

  app.get<{ Querystring: { floor?: string; limit?: string } }>('/api/events', async req => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    return store.recentEvents(limit, req.query.floor ? Number(req.query.floor) : undefined);
  });

  // ───────── 업무 · 결재 ─────────

  app.get('/api/work', async () => ({ tasks: tasks.list(), approvals: tasks.pendingApprovals(), terminalMode: tasks.terminalMode }));

  app.post<{ Body: { terminalMode: string } }>('/api/settings', async req => {
    const mode = req.body?.terminalMode;
    if (mode !== 'terminal' && mode !== 'office') throw new TaskError('terminalMode는 terminal 또는 office');
    tasks.terminalMode = mode;
    return { terminalMode: tasks.terminalMode };
  });

  app.get<{ Params: { teamId: string } }>('/api/teams/:teamId/agents', async req => {
    const team = config.floors.flatMap(f => f.teams).find(t => t.id === req.params.teamId);
    if (!team) throw new TaskError('없는 팀입니다');
    return agentsOf(team.path);
  });

  app.post<{ Body: { instruction: string; teamId: string; agent?: string | null; title?: string; source?: TaskSource; draft?: boolean } }>(
    '/api/tasks', async req => tasks.create(req.body ?? ({} as never)));

  app.get<{ Params: { id: string } }>('/api/tasks/:id/log', async req => tasks.log(Number(req.params.id)));

  app.post<{ Params: { id: string }; Body: { teamId?: string; agent?: string | null; instruction?: string; title?: string } }>(
    '/api/tasks/:id/start', async req => tasks.start(Number(req.params.id), req.body ?? {}));

  app.post<{ Params: { id: string }; Body: { text: string } }>(
    '/api/tasks/:id/message', async req => tasks.message(Number(req.params.id), req.body?.text ?? ''));

  app.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async req => tasks.stop(Number(req.params.id)));

  app.post<{ Params: { id: string } }>('/api/tasks/:id/archive', async req => {
    tasks.archive(Number(req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { approve: boolean; note?: string } }>(
    '/api/approvals/:id', async req => tasks.decide(Number(req.params.id), Boolean(req.body?.approve), req.body?.note ?? ''));

  /** 대표실 채팅: 비서가 업무 초안을 만든다 (초안은 대표가 확인 후 보냄) */
  app.post<{ Body: { text: string } }>('/api/secretary', async req => {
    const text = req.body?.text?.trim();
    if (!text) throw new TaskError('말씀이 비어 있습니다');
    const answer = await secretary(text);
    const drafts = answer.drafts.map(d => tasks.create({ ...d, source: 'secretary', draft: true }));
    return { reply: answer.reply, drafts };
  });

  app.get('/ws', { websocket: true }, socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    const snapshot: ServerMessage = {
      type: 'snapshot', workers: office.list(), floors: office.floorSummaries(), recent: store.recentEvents(50),
      tasks: tasks.list(), approvals: tasks.pendingApprovals(), terminalMode: tasks.terminalMode,
    };
    socket.send(JSON.stringify(snapshot));
  });

  const timer = setInterval(() => {
    const { changed, removed } = office.tick(now());
    if (changed.length || removed.length) broadcast({ type: 'tick', changed, removed, floors: office.floorSummaries() });
  }, 30_000);
  app.addHook('onClose', async () => {
    closing = true;
    clearInterval(timer);
    tasks.shutdown();
  });

  // Fastify 인스턴스는 thenable이라 async 반환값으로 그대로 내보내면 타입이 풀린다 → 객체로 감싼다
  return { app, office, tasks, security };
}
