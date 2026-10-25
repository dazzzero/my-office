// 지시·결재 API 보호.
// 마이오피스 서버는 Claude를 실행할 수 있으므로, 내 PC의 다른 웹페이지가 몰래 요청을 보내지 못하게 막는다.
//  1) Host 검사: 127.0.0.1/localhost로 온 요청만 (DNS 리바인딩 공격 차단)
//  2) Origin 검사: 브라우저 요청은 내 PC 주소(127.0.0.1/localhost)에서 온 것만 (다른 사이트의 몰래 요청·WebSocket 차단)
//  3) 화면 키: 값을 바꾸는 API는 화면만 아는 키가 있어야 (다른 사이트는 응답을 읽을 수 없어 키를 못 얻음)
// 휴대폰(원격): 서버는 여전히 127.0.0.1에서만 열려 있고, Tailscale serve가 https://<내PC>.ts.net 요청을 넘겨준다.
//  4) 원격 요청은 내 PC의 Tailscale 주소·내 계정에서 온 것만, 그리고 연결된 기기 키가 있어야 /api·/ws를 쓸 수 있다
//     (화면 파일(HTML·JS·3D 모델)은 회사 정보가 없어서 키 없이 받는다 — 연결 화면을 띄워야 하므로)
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Device, TailnetInfo } from '../../shared/src/mobile.ts';

const LOCAL = new Set(['127.0.0.1', 'localhost']);
const hostname = (hostHeader: string) => hostHeader.replace(/:\d+$/, '').toLowerCase();
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/** 휴대폰에서 기기 키 없이 부를 수 있는 API (연결 코드로 키 받기) */
const OPEN_REMOTE = new Set(['/api/devices/claim']);
/** PC에서만 되는 API (새 기기 연결·해제) */
const LOCAL_ONLY = [/^\/api\/devices\/pair$/, /^\/api\/devices\/\d+\/revoke$/, /^\/hook$/];

export interface Security {
  /** 화면이 /api/session에서 받아 가는 키 */
  uiKey: string;
  check: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export interface SecurityOptions {
  /** 이 PC의 Tailscale 상태 (휴대폰 요청 검사용). 없으면 원격 요청은 모두 거절 */
  tailnet?: () => TailnetInfo;
  /** 기기 키 확인 */
  verifyDevice?: (token: string | undefined) => Device | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** 휴대폰에서 온 요청이면 그 기기 */
    device?: Device;
  }
}

/** Tailscale serve를 거쳐 들어온 요청인지 (내 PC 안의 요청엔 이런 표시가 없다) */
export function isRemote(req: FastifyRequest): boolean {
  const host = hostname(one(req.headers.host));
  return !!req.headers['tailscale-user-login'] || !!req.headers['x-forwarded-for'] || !!req.headers['x-forwarded-host'] || !LOCAL.has(host);
}

export function createSecurity(uiKey: string = randomUUID(), o: SecurityOptions = {}): Security {
  const deny = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });

  const local = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!LOCAL.has(hostname(one(req.headers.host)))) return deny(reply, 403, '허용되지 않은 주소');
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = LOCAL.has(new URL(origin).hostname); } catch {}
      if (!ok) return deny(reply, 403, '허용되지 않은 출처');
    }
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    // /hook은 Claude Code가 보내므로 별도 토큰으로 검사한다
    if (mutating && req.url.startsWith('/api/') && req.headers['x-myoffice-key'] !== uiKey) {
      return deny(reply, 403, '화면 키가 없습니다');
    }
  };

  const remote = async (req: FastifyRequest, reply: FastifyReply) => {
    const ts = o.tailnet?.();
    const mine = ts?.dnsName?.toLowerCase();
    const host = hostname(one(req.headers.host));
    const fwd = hostname(one(req.headers['x-forwarded-host']));
    if (!mine || (host !== mine && fwd !== mine)) return deny(reply, 403, '허용되지 않은 주소');
    const login = one(req.headers['tailscale-user-login']);
    if (login && ts?.login && login.toLowerCase() !== ts.login.toLowerCase()) return deny(reply, 403, '내 Tailscale 계정이 아닙니다');
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).hostname.toLowerCase() === mine; } catch {}
      if (!ok) return deny(reply, 403, '허용되지 않은 출처');
    }
    const path = req.url.split('?')[0];
    if (LOCAL_ONLY.some(r => r.test(path))) return deny(reply, 403, 'PC에서만 할 수 있어요');
    if (!path.startsWith('/api/') && path !== '/ws') return; // 화면 파일
    if (OPEN_REMOTE.has(path)) return;
    const token = one(req.headers['x-myoffice-device']) || (path === '/ws' ? new URL(req.url, 'http://x').searchParams.get('device') ?? '' : '');
    const device = o.verifyDevice?.(token) ?? null;
    if (!device) return deny(reply, 401, '휴대폰 연결이 필요합니다');
    req.device = device;
  };

  const check = async (req: FastifyRequest, reply: FastifyReply) => (isRemote(req) ? remote(req, reply) : local(req, reply));
  return { uiKey, check };
}
