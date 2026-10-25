// 지시·결재 API 보호.
// 마이오피스 서버는 Claude를 실행할 수 있으므로, 내 PC의 다른 웹페이지가 몰래 요청을 보내지 못하게 막는다.
//  1) Host 검사: 127.0.0.1/localhost로 온 요청만 (DNS 리바인딩 공격 차단)
//  2) Origin 검사: 브라우저 요청은 내 PC 주소(127.0.0.1/localhost)에서 온 것만 (다른 사이트의 몰래 요청·WebSocket 차단)
//  3) 화면 키: 값을 바꾸는 API는 화면만 아는 키가 있어야 (다른 사이트는 응답을 읽을 수 없어 키를 못 얻음)
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const LOCAL = new Set(['127.0.0.1', 'localhost']);
const hostname = (hostHeader: string) => hostHeader.replace(/:\d+$/, '').toLowerCase();

export interface Security {
  /** 화면이 /api/session에서 받아 가는 키 */
  uiKey: string;
  check: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export function createSecurity(uiKey: string = randomUUID()): Security {
  const check = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!LOCAL.has(hostname(String(req.headers.host ?? '')))) return reply.code(403).send({ error: '허용되지 않은 주소' });
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = LOCAL.has(new URL(origin).hostname); } catch {}
      if (!ok) return reply.code(403).send({ error: '허용되지 않은 출처' });
    }
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    // /hook은 Claude Code가 보내므로 별도 토큰으로 검사한다
    if (mutating && req.url.startsWith('/api/') && req.headers['x-myoffice-key'] !== uiKey) {
      return reply.code(403).send({ error: '화면 키가 없습니다' });
    }
  };
  return { uiKey, check };
}
