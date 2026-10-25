// 서버 API 호출. 값을 바꾸는 요청에는 화면 키를 붙인다 (서버가 다른 사이트의 몰래 요청을 막는 데 씀).
let key = '';

export async function initKey(): Promise<void> {
  key = ((await (await fetch('/api/session')).json()) as { key: string }).key;
}

export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-myoffice-key': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data;
}
