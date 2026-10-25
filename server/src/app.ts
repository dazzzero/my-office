import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import type { WebSocket } from 'ws';
import type { MyOfficeConfig } from '../../shared/src/config.ts';
import type { OfficeEvent, ServerMessage } from '../../shared/src/events.ts';
import type { AttendeeInput, Meeting, MeetingKind } from '../../shared/src/meetings.ts';
import type { MobilePrefs, MobileStatus, TailnetInfo } from '../../shared/src/mobile.ts';
import QRCode from 'qrcode';
import { Devices, type PushSubscriptionJSON } from './devices.ts';
import { MobilePush, type PushSender } from './push.ts';
import { OFF, readTailnet } from './tailnet.ts';
import type { Approval, Task, TaskSource } from '../../shared/src/tasks.ts';
import { listAgents } from './agents.ts';
import { ROOT, createTeamMatcher } from './config.ts';
import type { Store } from './db.ts';
import type { GitReader } from './gitinfo.ts';
import { MeetingManager } from './meetings.ts';
import { MorningRoutine } from './morning.ts';
import { normalize, shrink, type HookPayload } from './normalize.ts';
import { createOneShot, type OneShot } from './oneshot.ts';
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
  onApproval?: (a: Approval, t: Task | null) => void;
  /** 회의가 끝났을 때 (윈도우 알림) */
  onMeeting?: (m: Meeting) => void;
  /** 빌드된 화면(web/dist). 있으면 / 에서 서빙 */
  webRoot?: string;
  security?: Security;
  /** 테스트용: 진짜 claude.exe 대신 가짜 프로세스 */
  spawner?: Spawner;
  agentsOf?: (teamPath: string) => { name: string; description: string }[];
  secretary?: (text: string) => Promise<SecretaryAnswer>;
  /** 테스트용: 회의의 Claude 호출·git 읽기를 가짜로 */
  ask?: OneShot;
  git?: GitReader;
  /** 회의록 폴더 (기본: 설정의 meetingNotesDir) */
  notesDir?: string;
  /** 아침 루틴 스케줄 켜기 (서버 실행 시에만, 테스트는 끔) */
  schedule?: boolean;
  /** 이 PC의 Tailscale 상태 읽기 (테스트에서 바꿔 끼움) */
  tailnet?: () => Promise<TailnetInfo>;
  /** 휴대폰 푸시 보내기 (테스트에서 바꿔 끼움) */
  pushSender?: PushSender;
  log?: (msg: string) => void;
}

/** `npm run demo`가 보내는 가짜 세션. 화면에는 보이지만 DB에는 남기지 않는다 */
export const isDemoSession = (sessionId: string) => sessionId.startsWith('demo-');

export async function buildApp(o: AppOptions) {
  const { config, store, token, now = Date.now, onEvent, webRoot } = o;
  const devices = new Devices(store.db, now);
  // 휴대폰이 들어오는 Tailscale 주소·계정. 1분마다 새로 읽는다 (나중에 Tailscale을 켜도 반영되게)
  let tailnet: TailnetInfo = OFF;
  const readTs = o.tailnet ?? (() => readTailnet(config.server.port));
  const refreshTailnet = async () => { tailnet = await readTs().catch(() => OFF); return tailnet; };
  // 서버 시작을 붙잡지 않게 기다리지 않는다 (읽기 전 몇 초간 휴대폰 요청은 거절될 뿐)
  void refreshTailnet();
  const tsTimer = setInterval(() => void refreshTailnet(), 60_000);
  tsTimer.unref?.();
  const security = o.security ?? createSecurity(undefined, { tailnet: () => tailnet, verifyDevice: t => devices.verify(t) });
  const agentsOf = o.agentsOf ?? ((p: string) => listAgents(p));
  const ask = o.ask ?? createOneShot(config.runner);
  const secretary = o.secretary ?? ((text: string) => askSecretary(config, agentsOf, text, ROOT, ask));
  const log = o.log ?? (() => {});

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

  /** 연결된 화면. 휴대폰이면 기기 id (연결을 끊으면 바로 닫으려고) */
  const clients = new Map<WebSocket, number | null>();
  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients.keys()) ws.send(data);
  };

  const push = new MobilePush({ db: store.db, config, devices, sender: o.pushSender, log });
  // 처리된 결재의 휴대폰 알림은 지운다 (PC·다른 기기에서 처리했을 때)
  let pendingIds = new Set<number>();

  // 업무·결재가 바뀌면 화면에 보낸다 (한 번에 여러 번 바뀌어도 한 번만)
  let workQueued = false;
  let closing = false;
  const tasks: TaskManager = new TaskManager({
    db: store.db, config, now, spawner: o.spawner, agentsOf,
    onApproval: (a, t) => {
      o.onApproval?.(a, t);
      push.approval(a, t, a.sessionId ? office.workers.get(a.sessionId)?.floor : null);
    },
    onFailed: t => push.failed(t),
    onChange: () => {
      if (workQueued || closing) return;
      workQueued = true;
      setImmediate(() => {
        workQueued = false;
        if (closing) return;
        const approvals = tasks.pendingApprovals();
        const now = new Set(approvals.map(a => a.id));
        for (const id of pendingIds) if (!now.has(id)) push.clear(`approval-${id}`);
        pendingIds = now;
        broadcast({ type: 'work', tasks: tasks.list(), approvals, terminalMode: tasks.terminalMode });
      });
    },
  });
  pendingIds = new Set(tasks.pendingApprovals().map(a => a.id));

  // 회의 목록이 바뀌면 화면에 보낸다 (여러 번 바뀌어도 한 번만)
  let meetingsQueued = false;
  const sendMeetings = () => {
    if (meetingsQueued || closing) return;
    meetingsQueued = true;
    setImmediate(() => {
      meetingsQueued = false;
      if (!closing) broadcast({ type: 'meetings', meetings: meetings.list(), morning: morning.status() });
    });
  };
  const meetings: MeetingManager = new MeetingManager({
    db: store.db, config, tasks, ask, agentsOf, git: o.git, now,
    notesDir: o.notesDir ?? config.meetingNotesDir,
    onChange: sendMeetings,
    onLine: line => { if (!closing) broadcast({ type: 'meeting.line', line }); },
    // 회의 참석자는 훅이 아니라 회의 엔진이 사무실에 넣고 뺀다
    onWorkers: (changed, removed) => {
      const c = office.put(changed, removed);
      if (!closing) broadcast({ type: 'tick', changed: c.changed, removed: c.removed, floors: office.floorSummaries() });
    },
    onFinished: m => { o.onMeeting?.(m); push.meeting(m); },
  });
  const morning = new MorningRoutine({ db: store.db, config: config.meetings.morning, meetings, now, onChange: sendMeetings, log });
  if (o.schedule) morning.start();

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof TaskError) return reply.code(400).send({ error: err.message });
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  app.post('/hook', async (req, reply) => {
    if (req.headers['x-myoffice-token'] !== token) return reply.code(401).send();
    const p = (req.body ?? {}) as HookPayload;
    const norm = normalize(p);
    // 회의 호출의 훅: 회의실 말풍선에만 반영 (따로 직원을 만들거나 DB·알림에 남기지 않는다)
    if (norm && p.session_id && meetings.claimHook(p.session_id, norm.kind, norm.tool, norm.summary)) return reply.code(204).send();
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

  /** 화면이 처음 열릴 때 키를 받아 간다. 다른 사이트는 이 응답을 읽을 수 없다. 휴대폰은 기기 키를 쓰므로 주지 않는다 */
  app.get('/api/session', async req => ({ key: req.device ? '' : security.uiKey }));

  // ───────── 휴대폰 ─────────

  const mobileStatus = async (): Promise<MobileStatus> => {
    const ts = await refreshTailnet();
    return { tailnet: ts, url: ts.dnsName && ts.certs && ts.serving ? `https://${ts.dnsName}` : null, devices: devices.list() };
  };

  app.get('/api/mobile', async req => ({ ...(await mobileStatus()), me: req.device ?? null, pushKey: push.keys.publicKey }));

  /** PC 화면: 휴대폰으로 찍을 QR (일회용 연결 코드, 10분) */
  app.post('/api/devices/pair', async () => {
    const ts = await refreshTailnet();
    if (!ts.dnsName) throw new TaskError('Tailscale이 켜져 있지 않아요. Tailscale을 켜고 로그인해 주세요');
    const { code, expiresAt } = devices.pairCode();
    const url = `https://${ts.dnsName}/?pair=${code}`;
    return { url, expiresAt, svg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  });

  /** 휴대폰: QR의 코드를 내고 기기 키를 받는다 */
  app.post<{ Body: { code?: string; name?: string } }>('/api/devices/claim', async req => devices.claim(String(req.body?.code ?? ''), String(req.body?.name ?? '')));

  app.post<{ Params: { id: string } }>('/api/devices/:id/revoke', async req => {
    const id = Number(req.params.id);
    devices.revoke(id);
    for (const [ws, dev] of clients) if (dev === id) ws.close();
    return { ok: true };
  });

  app.post('/api/devices/me/test', async req => {
    if (!req.device) throw new TaskError('휴대폰에서만 할 수 있어요');
    if (!push.test(req.device.id)) throw new TaskError('먼저 알림을 켜 주세요');
    return { ok: true };
  });

  /** 휴대폰: 내 기기 이름·푸시 등록·알림 종류 */
  app.post<{ Body: { name?: string; push?: PushSubscriptionJSON | null; prefs?: Partial<MobilePrefs> } }>('/api/devices/me', async req => {
    if (!req.device) throw new TaskError('휴대폰에서만 할 수 있어요');
    return devices.update(req.device.id, req.body ?? {});
  });

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

  /** 기다리는 계획 결재 모두 승인 */
  app.post('/api/approvals/approve-plans', async () => ({ approved: tasks.approveAllPlans() }));

  app.post<{ Params: { id: string }; Body: { approve: boolean; note?: string; picks?: number[] } }>(
    '/api/approvals/:id', async req => tasks.decide(Number(req.params.id), Boolean(req.body?.approve), req.body?.note ?? '',
      Array.isArray(req.body?.picks) ? req.body.picks.map(Number) : undefined));

  // ───────── 회의실 · 아침 루틴 ─────────

  app.get('/api/meetings', async () => ({ meetings: meetings.list(), morning: morning.status(), personas: meetings.personaList(), maxAttendees: config.meetings.maxAttendees, defaultRounds: config.meetings.defaultRounds }));

  app.get<{ Params: { id: string } }>('/api/meetings/:id', async req => {
    const id = Number(req.params.id);
    return { meeting: meetings.get(id), lines: meetings.lines(id) };
  });

  app.post<{ Body: { kind: MeetingKind; floor: number; title?: string; agenda?: string; attendees?: AttendeeInput[]; rounds?: number } }>(
    '/api/meetings', async req => {
      const b = req.body ?? ({} as never);
      if (b.kind === 'standup') return meetings.openStandup(Number(b.floor), { force: true });
      return meetings.open({ kind: b.kind, floor: Number(b.floor), title: b.title, agenda: b.agenda ?? '', attendees: b.attendees ?? [], rounds: b.rounds });
    });

  app.post<{ Params: { id: string } }>('/api/meetings/:id/stop', async req => meetings.stop(Number(req.params.id)));

  /** 아침 루틴 지금 실행 (바뀐 것 없는 층은 건너뜀) */
  app.post('/api/morning/run', async () => ({ meetings: await morning.run() }));

  /** 대표실 채팅: 비서가 업무 초안을 만든다 (초안은 대표가 확인 후 보냄) */
  app.post<{ Body: { text: string } }>('/api/secretary', async req => {
    const text = req.body?.text?.trim();
    if (!text) throw new TaskError('말씀이 비어 있습니다');
    const answer = await secretary(text);
    const drafts = answer.drafts.map(d => tasks.create({ ...d, source: 'secretary', draft: true }));
    return { reply: answer.reply, drafts };
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    clients.set(socket, req.device?.id ?? null);
    socket.on('close', () => clients.delete(socket));
    const snapshot: ServerMessage = {
      type: 'snapshot', workers: office.list(), floors: office.floorSummaries(), recent: store.recentEvents(50),
      tasks: tasks.list(), approvals: tasks.pendingApprovals(), terminalMode: tasks.terminalMode,
      meetings: meetings.list(), morning: morning.status(),
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
    clearInterval(tsTimer);
    morning.stop();
    meetings.shutdown();
    tasks.shutdown();
  });

  // Fastify 인스턴스는 thenable이라 async 반환값으로 그대로 내보내면 타입이 풀린다 → 객체로 감싼다
  return { app, office, tasks, meetings, morning, security, devices, push };
}
