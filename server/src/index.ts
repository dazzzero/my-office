import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.ts';
import { DATA_DIR, ROOT, loadConfig } from './config.ts';
import { Store } from './db.ts';
import { Notifier, showToast } from './notify.ts';
import { ensureToken } from './token.ts';

const config = loadConfig();
mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(join(DATA_DIR, 'myoffice.db'));
const floorLabel = new Map(config.floors.map(f => [f.floor, `${f.label} ${f.name}`]));
const notifier = new Notifier(config, showToast, undefined, id => store.lastPromptAt(id));

const { app, office } = await buildApp({
  config,
  store,
  token: ensureToken(),
  webRoot: join(ROOT, 'web', 'dist'),
  onEvent: e => {
    notifier.handle(e);
    if (e.id < 0) return; // 데모 이벤트는 로그에 남기지 않는다
    const time = new Date(e.ts).toTimeString().slice(0, 8);
    const who = e.agentType ? `${e.sessionId.slice(0, 8)}/${e.agentType}` : e.sessionId.slice(0, 8);
    console.log(`${time} [${floorLabel.get(e.floor)} · ${e.teamId}] ${who} ${e.kind} ${e.summary}`);
  },
});

const { host, port } = config.server;
await app.listen({ host, port });
console.log(`🏢 마이오피스 서버: http://${host}:${port}  (이벤트 ${store.countEvents()}건, 직원 ${office.workers.size}명 복원)`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    store.close();
    process.exit(0);
  });
}
