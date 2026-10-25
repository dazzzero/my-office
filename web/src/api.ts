// 서버 API 호출. 값을 바꾸는 요청에는 화면 키를 붙인다 (서버가 다른 사이트의 몰래 요청을 막는 데 씀).
// 휴대폰(Tailscale 주소로 연 경우)은 화면 키 대신 이 기기 전용 키를 붙인다.
let key = '';
const DEVICE_KEY = 'myoffice-device';

/** 내 PC가 아니라 휴대폰 등에서 Tailscale 주소로 열었는지 */
export const isRemote = !['localhost', '127.0.0.1'].includes(location.hostname);

export const deviceToken = () => localStorage.getItem(DEVICE_KEY) ?? '';

/** 기기 키가 거절되면(연결 해제 등) 부른다 */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

const deviceName = () => {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? '안드로이드 휴대폰' : '안드로이드 태블릿';
  if (/iPhone/i.test(ua)) return '아이폰';
  if (/iPad/i.test(ua)) return '아이패드';
  return '다른 기기';
};

/** 휴대폰: 주소에 연결 코드(?pair=)가 있으면 기기 키로 바꾼다. 키가 있으면 true */
export async function pairIfNeeded(): Promise<boolean> {
  if (!isRemote) return true;
  const params = new URLSearchParams(location.search);
  const code = params.get('pair');
  if (code) {
    params.delete('pair');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
    const res = await fetch('/api/devices/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: deviceName() }) });
    const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!res.ok || !data.token) throw new Error(data.error ?? '연결하지 못했어요');
    localStorage.setItem(DEVICE_KEY, data.token);
  }
  return !!deviceToken();
}

export function forgetDevice(): void {
  localStorage.removeItem(DEVICE_KEY);
}

export async function initKey(): Promise<void> {
  key = isRemote ? '' : (await api<{ key: string }>('GET', '/api/session')).key;
}

export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...(isRemote ? { 'x-myoffice-device': deviceToken() } : { 'x-myoffice-key': key }),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401 && isRemote) onUnauthorized();
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data;
}

/** 실시간 연결 주소 (휴대폰은 기기 키를 붙인다 — WebSocket엔 헤더를 못 붙여서) */
export const wsUrl = () =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${isRemote ? `?device=${encodeURIComponent(deviceToken())}` : ''}`;
