import { useCallback, useEffect, useState } from 'react';
import type { Device, MobilePrefs, MobileStatus } from '../../../shared/src/mobile.ts';
import { api, isRemote } from '../api.ts';
import { disablePush, enablePush, pushSupported, syncPush } from '../push.ts';
import { attempt, useOffice } from '../store.ts';
import { ago } from './labels.ts';

type Status = MobileStatus & { me: Device | null; pushKey: string };

function useMobileStatus() {
  const [st, setSt] = useState<Status | null>(null);
  const reload = useCallback(() => { api<Status>('GET', '/api/mobile').then(setSt).catch(() => {}); }, []);
  useEffect(reload, [reload]);
  return { st, reload };
}

const Step = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <li className={ok ? 'ok' : 'todo'}><span>{ok ? '✅' : '⬜'}</span><div>{children}</div></li>
);

/** PC: 휴대폰 연결 준비 상태 · QR · 연결된 기기 */
function ConnectPhone() {
  const { st, reload } = useMobileStatus();
  const [qr, setQr] = useState<{ url: string; svg: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!st) return <div className="panel-body"><p className="empty">불러오는 중…</p></div>;
  const ts = st.tailnet;
  const ready = !!st.url;
  return (
    <div className="panel-body phone">
      <p className="hint">휴대폰에서도 이 사무실을 그대로 보고 결재·지시할 수 있어요. 서버는 인터넷에 공개되지 않고, <b>Tailscale로 연결된 내 기기</b>만 들어옵니다.</p>
      <h4>준비 <small className="link" onClick={reload}>새로 확인</small></h4>
      <ol className="steps">
        <Step ok={ts.running && !!ts.dnsName}>
          <b>이 PC에서 Tailscale 켜기·로그인</b>
          {ts.dnsName ? <em>{ts.dnsName}{ts.login ? ` · ${ts.login}` : ''}</em> : <em>Tailscale을 설치하고 로그인해 주세요</em>}
        </Step>
        <Step ok={ts.certs}>
          <b>HTTPS 인증서 켜기</b>
          <em>Tailscale 관리 페이지 → DNS → <b>HTTPS Certificates</b> "Enable" (한 번만). 앱 설치·알림에 필요해요</em>
          {!ts.certs && <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">관리 페이지 열기 ↗</a>}
        </Step>
        <Step ok={ts.serving}>
          <b>마이오피스를 Tailscale에 연결</b>
          <em>PC에서 <code>npm run phone:serve</code> (내 Tailscale 기기에서만 열림)</em>
        </Step>
        <Step ok={st.devices.length > 0}>
          <b>휴대폰 연결</b>
          <em>휴대폰에도 Tailscale을 깔고 같은 계정으로 로그인한 뒤, 아래 QR을 휴대폰 카메라로 찍기</em>
        </Step>
      </ol>
      <div className="actions">
        <button className="primary" disabled={busy || !ready} onClick={async () => {
          setBusy(true);
          const r = await attempt(() => api<{ url: string; svg: string; expiresAt: number }>('POST', '/api/devices/pair', {}));
          setBusy(false);
          if (r) setQr(r);
        }}>📱 휴대폰 연결 QR 만들기</button>
      </div>
      {!ready && <p className="hint">위 준비가 끝나면 QR을 만들 수 있어요.</p>}
      {qr && (
        <div className="qr">
          <div dangerouslySetInnerHTML={{ __html: qr.svg }} />
          <p className="hint">휴대폰 카메라로 찍어서 열기 → 연결됩니다. 이 QR은 <b>한 번만</b>, {new Date(qr.expiresAt).toTimeString().slice(0, 5)}까지 쓸 수 있어요.<br />
            그다음 크롬 메뉴(⋮) → <b>홈 화면에 추가</b>(앱 설치) → 앱에서 ☰ 더보기 → 📱 알림 켜기</p>
        </div>
      )}
      <h4>연결된 기기 <small>{st.devices.length}대</small></h4>
      {st.devices.length === 0 && <p className="empty">아직 없어요</p>}
      <ul className="devices">
        {st.devices.map(d => (
          <li key={d.id}>
            <div><b>{d.name}</b><em>{d.push ? '🔔 알림 받음' : '🔕 알림 꺼짐'} · {d.lastSeen ? `마지막 접속 ${ago(d.lastSeen)}` : ''}</em></div>
            <button className="danger" onClick={async () => {
              if (!confirm(`${d.name} 연결을 끊을까요? 다시 쓰려면 QR을 새로 찍어야 해요.`)) return;
              await attempt(() => api('POST', `/api/devices/${d.id}/revoke`, {}));
              reload();
            }}>연결 끊기</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const PREF_LABEL: Record<keyof MobilePrefs, string> = {
  approval: '📋 결재 요청 (계획·작업·Paseo)',
  today: '☀️ 오늘 할 일',
  meeting: '🗣️ 회의 끝',
  failed: '⚠️ 회의·업무 실패',
};

/** 휴대폰: 알림 켜기·종류, 3D 절전 모드 */
function PhoneSettings() {
  const { st, reload } = useMobileStatus();
  const powerSave = useOffice(s => s.powerSave);
  const setPowerSave = useOffice(s => s.setPowerSave);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (st?.pushKey) void syncPush(st.pushKey); }, [st?.pushKey]);
  if (!st?.me) return <div className="panel-body"><p className="empty">불러오는 중…</p></div>;
  const me = st.me;
  const supported = pushSupported();
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); await attempt(fn); setBusy(false); reload(); };
  return (
    <div className="panel-body phone">
      <h4>알림</h4>
      {!supported && <p className="hint">이 브라우저에선 알림을 받을 수 없어요. 크롬에서 열고 "홈 화면에 추가"로 설치해 주세요.</p>}
      {supported && (me.push
        ? <div className="actions"><span className="ok-line">🔔 이 기기로 알림을 받고 있어요</span><button disabled={busy} onClick={() => run(disablePush)}>알림 끄기</button></div>
        : <div className="actions"><button className="primary" disabled={busy} onClick={() => run(() => enablePush(st.pushKey))}>🔔 알림 켜기</button></div>)}
      {(Object.keys(PREF_LABEL) as (keyof MobilePrefs)[]).map(k => (
        <label key={k} className="check">
          <input type="checkbox" checked={me.prefs[k]} disabled={busy}
            onChange={e => run(() => api('POST', '/api/devices/me', { prefs: { [k]: e.target.checked } }))} />
          {PREF_LABEL[k]}
        </label>
      ))}
      <p className="hint">알림 문구는 "📋 계획 결재 · 2F"처럼 짧게만 보내고, 내용은 앱을 열어야 보여요. "작업 완료" 알림은 PC로만 가요.</p>
      <h4>화면</h4>
      <label className="check">
        <input type="checkbox" checked={powerSave} onChange={e => setPowerSave(e.target.checked)} />
        🔋 절전 모드 <em>3D 해상도를 낮추고 그림자를 꺼요 (배터리·발열 줄이기)</em>
      </label>
      <h4>이 기기</h4>
      <p className="hint">{me.name} · 연결 {ago(me.createdAt)}. 연결 끊기는 PC의 📱 휴대폰 창에서 해요.</p>
    </div>
  );
}

export function PhonePanel() {
  return isRemote ? <PhoneSettings /> : <ConnectPhone />;
}
