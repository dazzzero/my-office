import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import type { WebSocket } from 'ws';
import type { MyOfficeConfig } from '../../shared/src/config.ts';
import type { OfficeEvent, ServerMessage } from '../../shared/src/events.ts';
import { createTeamMatcher } from './config.ts';
import type { Store } from './db.ts';
import { normalize, shrink, type HookPayload } from './normalize.ts';
import { OfficeState } from './state.ts';

const REPLAY_WINDOW = 12 * 60 * 60_000;

export interface AppOptions {
  config: MyOfficeConfig;
  store: Store;
  token: string;
  now?: () => number;
  /** 이벤트가 저장될 때마다 호출 (서버 로그용) */
  onEvent?: (e: OfficeEvent) => void;
  /** 빌드된 화면(web/dist). 있으면 / 에서 서빙 */
  webRoot?: string;
}

/** `npm run demo`가 보내는 가짜 세션. 화면에는 보이지만 DB에는 남기지 않는다 */
export const isDemoSession = (sessionId: string) => sessionId.startsWith('demo-');

export async function buildApp({ config, store, token, now = Date.now, onEvent, webRoot }: AppOptions) {
  // Read 결과처럼 큰 페이로드도 받아야 한다. 거절하면 그 이벤트를 잃는다.
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
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
    // 빈 2xx = "아무 결정도 하지 않음". Claude Code는 평소대로 진행한다
    return reply.code(204).send();
  });

  app.get('/health', async () => ({ ok: true, events: store.countEvents(), workers: office.workers.size }));

  app.get('/api/config', async () => ({
    defaultFloor: config.defaultFloor,
    floors: config.floors,
  }));

  app.get('/api/state', async () => ({ workers: office.list(), floors: office.floorSummaries() }));

  app.get<{ Querystring: { floor?: string; limit?: string } }>('/api/events', async req => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    return store.recentEvents(limit, req.query.floor ? Number(req.query.floor) : undefined);
  });

  app.get('/ws', { websocket: true }, socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    const snapshot: ServerMessage = { type: 'snapshot', workers: office.list(), floors: office.floorSummaries(), recent: store.recentEvents(50) };
    socket.send(JSON.stringify(snapshot));
  });

  const timer = setInterval(() => {
    const { changed, removed } = office.tick(now());
    if (changed.length || removed.length) broadcast({ type: 'tick', changed, removed, floors: office.floorSummaries() });
  }, 30_000);
  app.addHook('onClose', async () => clearInterval(timer));

  // Fastify 인스턴스는 thenable이라 async 반환값으로 그대로 내보내면 타입이 풀린다 → 객체로 감싼다
  return { app, office };
}
