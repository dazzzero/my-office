// 앱 설치(서비스 워커)와 휴대폰 푸시 알림 등록.
import { api, isRemote } from './api.ts';
import { openFromUrl, useOffice } from './store.ts';

/** 서비스 워커: 3D 모델·화면 파일을 휴대폰에 저장해 두고, 푸시 알림을 받는다 (HTTPS·내 PC에서만 동작) */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  await navigator.serviceWorker.register('/sw.js').catch(() => {});
  // 알림을 눌렀는데 앱이 이미 열려 있으면 서비스 워커가 여기로 알려 준다
  navigator.serviceWorker.addEventListener('message', e => { if (e.data?.open) openFromUrl(e.data.open); });
  // 앱을 볼 때 이미 처리된 결재 알림은 지운다
  const tidy = () => { if (!document.hidden) void closeHandled(); };
  document.addEventListener('visibilitychange', tidy);
  useOffice.subscribe((s, prev) => { if (s.approvals !== prev.approvals) tidy(); });
}

export const pushSupported = () => isRemote && 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;

const keyBytes = (base64url: string) => {
  const s = atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};

/** 알림 허용을 묻고(버튼을 누를 때만 물을 수 있음) 이 기기를 푸시 받을 곳으로 등록 */
export async function enablePush(pushKey: string): Promise<void> {
  if (!pushSupported()) throw new Error('이 브라우저에선 알림을 받을 수 없어요 (크롬에서 HTTPS 주소로 열어 주세요)');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('알림이 차단돼 있어요. 크롬 사이트 설정에서 알림을 허용해 주세요');
  await subscribe(pushKey);
}

/** 이미 허용된 기기면 앱을 열 때마다 등록을 맞춰 둔다 (서버 키가 바뀌었거나 구독이 만료됐을 때) */
export async function syncPush(pushKey: string): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  await subscribe(pushKey).catch(() => {});
}

async function subscribe(pushKey: string): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const want = keyBytes(pushKey);
  const have = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && (!have || have.length !== want.length || have.some((b, i) => b !== want[i]))) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  await api('POST', '/api/devices/me', { push: sub.toJSON() });
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  await (await reg.pushManager.getSubscription())?.unsubscribe();
  await api('POST', '/api/devices/me', { push: null });
}

/** 결재함에 더는 없는 결재의 알림을 닫는다 */
async function closeHandled(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  const pending = new Set(useOffice.getState().approvals.map(a => `approval-${a.id}`));
  for (const n of await reg.getNotifications()) {
    if ((n.tag.startsWith('approval-') && !pending.has(n.tag)) || n.tag === 'handled') n.close();
  }
}
