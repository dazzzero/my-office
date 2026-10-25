// 공통 금지 목록 판단 (순수 함수). guard.mjs와 테스트가 함께 쓴다.

/** 경로 비교용 정규화 (server/src/config.ts의 normPath와 같은 규칙) */
export function normPath(p) {
  return String(p)
    .replace(/^\/([a-zA-Z])(\/|$)/, '$1:\\')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/** 등록된 프로젝트(팀) 폴더 안인지 */
export function isRegistered(config, cwd) {
  if (!cwd) return false;
  const p = normPath(cwd);
  return config.floors.some(f => f.teams.some(t => {
    const k = normPath(t.path);
    return p === k || p.startsWith(k + '\\');
  }));
}

/**
 * PreToolUse 입력을 보고 금지 목록에 걸리는지 판단한다.
 * @returns {{ action: 'ask'|'deny', rule: object } | null}
 */
export function decide(config, payload) {
  const tool = payload?.tool_name;
  const command = String(payload?.tool_input?.command ?? '');
  if (!tool || !command || !isRegistered(config, payload.cwd)) return null;
  const hits = (config.guard ?? []).filter(r =>
    r.tools.includes(tool) && r.allOf.every(src => new RegExp(src, 'i').test(command)));
  if (!hits.length) return null;
  // deny가 하나라도 있으면 deny가 우선
  const rule = hits.find(r => r.action === 'deny') ?? hits[0];
  return { action: rule.action, rule };
}

/** Claude Code에 돌려줄 훅 출력 */
export function hookOutput(result) {
  const reason = result.action === 'deny'
    ? `마이오피스 금지 목록에 걸려 차단했습니다: ${result.rule.description}. 이 작업은 사용자에게 직접 하도록 안내하세요.`
    : `마이오피스 금지 목록: ${result.rule.description} — 사용자 결재가 필요합니다.`;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.action, permissionDecisionReason: reason } };
}
