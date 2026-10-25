// 윈도우 알림: 결재 대기 · 오류 · 작업 완료 · 자동 모드가 막은 작업.
// 판단(Notifier)과 실제 표시(showToast)를 나눠서 판단 로직은 테스트할 수 있게 한다.
import { spawn } from 'node:child_process';
import type { MyOfficeConfig } from '../../shared/src/config.ts';
import type { OfficeEvent } from '../../shared/src/events.ts';
import { workerFullName } from '../../shared/src/identity.ts';

const DEDUPE_MS = 60_000;

export interface Toast {
  title: string;
  body: string;
  /** 알림을 누르면 열 주소 */
  url: string;
}

/** 테스트에서 시간을 직접 돌릴 수 있게 타이머를 주입받는다 */
export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as NodeJS.Timeout) };

const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ''}`;
};

export class Notifier {
  private readonly config: MyOfficeConfig;
  private readonly send: (t: Toast) => void;
  private readonly timers: Timers;
  private readonly lookupPrompt: (sessionId: string) => number | undefined;
  private readonly baseUrl: string;
  private promptAt = new Map<string, number>();
  private pendingDone = new Map<string, unknown>();
  private lastSent = new Map<string, number>();

  /** lookupPrompt: 메모리에 없을 때(서버 재시작 등) 지시 받은 시각을 DB에서 찾는다 */
  constructor(config: MyOfficeConfig, send: (t: Toast) => void, timers: Timers = realTimers, lookupPrompt: (sessionId: string) => number | undefined = () => undefined) {
    this.config = config;
    this.send = send;
    this.timers = timers;
    this.lookupPrompt = lookupPrompt;
    this.baseUrl = `http://${config.server.host}:${config.server.port}`;
  }

  handle(e: OfficeEvent): void {
    const rules = this.config.notifications.windows;
    if (!rules.enabled || e.sessionId.startsWith('demo-')) return;
    const floor = this.config.floors.find(f => f.floor === e.floor);
    const where = `${floor?.label} ${floor?.name}`;
    const who = workerFullName(e);
    const url = `${this.baseUrl}/?floor=${e.floor}`;

    if (e.kind === 'prompt') {
      // 새 지시가 오면 직전 작업의 완료 알림은 취소 (연달아 일하는 중)
      this.cancelDone(e.sessionId);
      this.promptAt.set(e.sessionId, e.ts);
    }

    if (rules.waiting && (e.kind === 'permission.request' || (e.kind === 'notification' && e.summary === '결재 대기'))) {
      this.once(`wait:${e.sessionId}:${e.agentId}`, e.ts, { title: `✋ 결재 대기 · ${where}`, body: `${who} — ${e.summary.replace(/^결재 요청: /, '')}`, url });
    }
    if (rules.denied && e.kind === 'permission.denied') {
      this.once(`deny:${e.sessionId}:${e.summary}`, e.ts, { title: `🛡️ 자동 모드가 막은 작업 · ${where}`, body: `${who} — ${e.summary.replace(/^자동 모드가 막음: /, '')}`, url });
    }
    if (rules.error && e.kind === 'stop.fail') {
      this.cancelDone(e.sessionId);
      this.once(`err:${e.sessionId}`, e.ts, { title: `⚠️ 오류로 멈춤 · ${where}`, body: `${who} — ${e.summary}`, url });
    }
    if (rules.done && e.kind === 'stop') {
      this.cancelDone(e.sessionId);
      const started = this.promptAt.get(e.sessionId) ?? this.lookupPrompt(e.sessionId);
      const took = started !== undefined ? `${duration(e.ts - started)} 걸린 작업이 끝났어요` : '작업이 끝났어요';
      this.pendingDone.set(e.sessionId, this.timers.set(() => {
        this.pendingDone.delete(e.sessionId);
        this.send({ title: `✅ 작업 완료 · ${where}`, body: `${who} — ${took}`, url });
      }, rules.doneQuietSeconds * 1000));
    }
    if (e.kind === 'session.end') {
      this.cancelDone(e.sessionId);
      this.promptAt.delete(e.sessionId);
    }
  }

  private cancelDone(sessionId: string): void {
    const h = this.pendingDone.get(sessionId);
    if (h !== undefined) this.timers.clear(h);
    this.pendingDone.delete(sessionId);
  }

  /** 같은 직원의 같은 알림은 1분에 한 번만 */
  private once(key: string, ts: number, toast: Toast): void {
    const last = this.lastSent.get(key);
    if (last !== undefined && ts - last < DEDUPE_MS) return;
    this.lastSent.set(key, ts);
    this.send(toast);
  }
}

const xml = (s: string) => s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** Windows 기본 알림. 추가 설치 없이 Windows PowerShell의 알림 기능을 쓴다 */
export function showToast(t: Toast): void {
  const toastXml = `<toast activationType="protocol" launch="${xml(t.url)}"><visual><binding template="ToastGeneric"><text>${xml(t.title)}</text><text>${xml(t.body)}</text></binding></visual></toast>`;
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml('${toastXml.replace(/'/g, "''")}')`,
    "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const exe = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
}
