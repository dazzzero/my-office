// 데모 시뮬레이터: 실제 세션 없이 사무실이 움직이도록 가짜 Claude Code 훅 이벤트를 서버로 보낸다.
// 세션 id가 demo- 로 시작하므로 화면에만 보이고 DB에는 남지 않는다.
// 사용: node scripts/demo.mjs [--count 12] [--fast]
import { ensureToken, loadConfig, serverUrl } from '../hooks/common.mjs';

const args = process.argv.slice(2);
const count = Number(args[args.indexOf('--count') + 1]) || 12;
const speed = args.includes('--fast') ? 0.4 : 1;
const config = loadConfig();
// --floor N: 한 층에 몰아넣기 (성능 측정용 최악 상황)
const onlyFloor = Number(args[args.indexOf('--floor') + 1]) || null;
const teams = config.floors.filter(f => !onlyFloor || f.floor === onlyFloor).flatMap(f => f.teams);
const url = `${serverUrl()}/hook`;
const token = ensureToken();

const pick = a => a[Math.floor(Math.random() * a.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms * speed));
const between = (a, b) => a + Math.random() * (b - a);

const FILES = ['src/views/LoginView.vue', 'src/api/client.ts', 'src/main/java/app/order/OrderService.java', 'README.md', 'build.gradle', 'src/components/OrderTable.vue'];
const TOOLS = [
  ['Read', () => ({ file_path: pick(FILES) })],
  ['Grep', () => ({ pattern: pick(['useAuth', 'totalPrice', 'TODO', 'selectOrderList']) })],
  ['Glob', () => ({ pattern: pick(['**/*.vue', 'src/**/*.java']) })],
  ['Edit', () => ({ file_path: pick(FILES) })],
  ['Write', () => ({ file_path: pick(FILES) })],
  ['Bash', () => ({ command: pick(['npm run build', 'gradlew test', 'git status', 'git diff --stat']), description: pick(['빌드', '테스트 실행', '변경 확인', '']) })],
  ['WebSearch', () => ({ query: pick(['vue 3 composition api', 'spring batch retry']) })],
  ['mcp__mariadb__search_objects', () => ({})],
  ['TodoWrite', () => ({})],
];

async function send(base, payload) {
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-myoffice-token': token }, body: JSON.stringify({ ...base, ...payload }) });
  } catch {
    console.error('서버에 연결할 수 없습니다. 먼저 npm run server 를 실행하세요.');
    process.exit(1);
  }
}

async function toolCall(base, extra = {}) {
  const [tool_name, input] = pick(TOOLS);
  await send(base, { hook_event_name: 'PreToolUse', tool_name, tool_input: input(), ...extra });
  if (Math.random() < 0.08 && ['Bash', 'Edit', 'Write'].includes(tool_name)) {
    await send(base, { hook_event_name: 'PermissionRequest', tool_name, tool_input: input(), ...extra });
    await sleep(between(6000, 15000)); // 결재 대기
  }
  await sleep(between(2500, 7000));
  await send(base, { hook_event_name: 'PostToolUse', tool_name, ...extra });
}

async function session(i) {
  for (;;) {
    const team = teams[i % teams.length];
    const base = { session_id: `demo-${i}-${Date.now().toString(36)}`, cwd: team.path };
    await sleep(between(0, 4000));
    await send(base, { hook_event_name: 'SessionStart', source: 'startup' });
    const turns = Math.floor(between(2, 6));
    for (let t = 0; t < turns; t++) {
      await send(base, { hook_event_name: 'UserPromptSubmit', prompt: pick(['주문 목록 화면 버그 고쳐줘', '테스트 추가해줘', 'API 문서 정리해줘', '빌드 에러 확인해줘']) });
      const calls = Math.floor(between(3, 8));
      for (let c = 0; c < calls; c++) {
        if (Math.random() < 0.15) {
          const sub = { agent_id: `a${Date.now().toString(36)}`, agent_type: pick(['Explore', 'bug-fixer', 'feature-developer']) };
          await send(base, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: sub.agent_type, description: '조사' } });
          await send(base, { hook_event_name: 'SubagentStart', ...sub });
          for (let k = 0; k < 3; k++) await toolCall(base, sub);
          await send(base, { hook_event_name: 'SubagentStop', ...sub });
        } else {
          await toolCall(base);
        }
      }
      await send(base, { hook_event_name: 'Stop' });
      await sleep(between(5000, 12000));
    }
    await send(base, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
    await sleep(between(3000, 8000));
  }
}

console.log(`🎬 데모: 가짜 세션 ${count}개를 ${url} 로 보냅니다. 멈추려면 Ctrl+C`);
for (let i = 0; i < count; i++) session(i);
