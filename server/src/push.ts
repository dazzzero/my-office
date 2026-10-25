// 휴대폰 푸시 알림 (표준 Web Push). 내용은 표준 암호화로 구글 푸시 서버도 읽을 수 없고,
// 그래도 문구는 짧게("📋 계획 결재 · 2F") — 자세한 건 앱을 열어야 보인다.
import type { DatabaseSync } from 'node:sqlite';
import webpush from 'web-push';
import type { MyOfficeConfig } from '../../shared/src/config.ts';
import type { Meeting } from '../../shared/src/meetings.ts';
import type { MobilePrefs, PushNote } from '../../shared/src/mobile.ts';
import type { Approval, Task, TodayChecklist } from '../../shared/src/tasks.ts';
import type { Devices, PushSubscriptionJSON } from './devices.ts';

/** 보내기 (테스트에서 바꿔 끼움). 구독이 사라졌으면 statusCode 404/410으로 실패 */
export type PushSender = (sub: PushSubscriptionJSON, payload: string, keys: VapidKeys) => Promise<unknown>;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const SUBJECT = 'https://github.com/dazzzero/my-office';

const realSender: PushSender = (sub, payload, keys) =>
  webpush.sendNotification(sub, payload, { vapidDetails: { subject: SUBJECT, ...keys }, TTL: 6 * 60 * 60, urgency: 'high' });

export class MobilePush {
  private readonly config: MyOfficeConfig;
  private readonly devices: Devices;
  private readonly sender: PushSender;
  private readonly log: (msg: string) => void;
  readonly keys: VapidKeys;

  constructor(o: { db: DatabaseSync; config: MyOfficeConfig; devices: Devices; sender?: PushSender; log?: (msg: string) => void }) {
    this.config = o.config;
    this.devices = o.devices;
    this.sender = o.sender ?? realSender;
    this.log = o.log ?? (() => {});
    this.keys = loadKeys(o.db);
  }

  /** 결재가 새로 생겼을 때. terminal은 floor를 세션이 있는 층으로 받는다 */
  approval(a: Approval, t: Task | null, sessionFloor?: number | null): void {
    if (a.kind === 'today') {
      const list = a.input as unknown as TodayChecklist;
      this.send('today', { tag: `approval-${a.id}`, title: `☀️ 오늘 할 일 ${list.items.length}건 · ${this.where(list.floor)}`, body: '눌러서 고르기', url: `/?floor=${list.floor}&open=approvals` });
      return;
    }
    const floor = t?.floor ?? sessionFloor ?? null;
    const what = a.kind === 'plan' ? '📋 계획 결재' : a.kind === 'terminal' ? '💻 Paseo 결재' : '✋ 작업 결재';
    this.send('approval', { tag: `approval-${a.id}`, title: `${what}${floor ? ` · ${this.where(floor)}` : ''}`, body: '눌러서 확인', url: `/?${floor ? `floor=${floor}&` : ''}open=approvals` });
  }

  meeting(m: Meeting): void {
    if (m.status === 'failed') {
      this.send('failed', { tag: `meeting-${m.id}`, title: `⚠️ 회의 실패 · ${this.where(m.floor)}`, body: '눌러서 확인', url: `/?floor=${m.floor}&open=meeting-${m.id}` });
    } else if (m.status === 'done' && m.kind !== 'standup') {
      this.send('meeting', { tag: `meeting-${m.id}`, title: `🗣️ 회의 끝 · ${this.where(m.floor)}`, body: `할 일 ${m.taskIds.length}건`, url: `/?floor=${m.floor}&open=meeting-${m.id}` });
    }
  }

  failed(t: Task): void {
    this.send('failed', { tag: `task-${t.id}`, title: `⚠️ 업무 실패 · ${this.where(t.floor)}`, body: '눌러서 확인', url: `/?floor=${t.floor}&open=task-${t.id}` });
  }

  /** 다른 곳(PC·다른 기기)에서 처리된 알림은 지운다 */
  clear(tag: string): void {
    this.dispatch(this.devices.pushTargets(), { type: 'clear', tag });
  }

  private where(floor: number): string {
    const f = this.config.floors.find(x => x.floor === floor);
    return f ? `${f.label} ${f.name}` : `${floor}층`;
  }

  private send(kind: keyof MobilePrefs, note: Omit<PushNote, 'type'>): void {
    this.dispatch(this.devices.pushTargets(kind), { type: 'show', ...note });
  }

  private dispatch(targets: { id: number; sub: PushSubscriptionJSON }[], note: PushNote): void {
    const payload = JSON.stringify(note);
    for (const { id, sub } of targets) {
      this.sender(sub, payload, this.keys).catch((e: { statusCode?: number; message?: string }) => {
        if (e.statusCode === 404 || e.statusCode === 410) this.devices.dropPush(id);
        else this.log(`📱 푸시 실패 (기기 ${id}): ${e.statusCode ?? ''} ${e.message ?? ''}`);
      });
    }
  }
}

/** 이 서버의 푸시 키. 처음 한 번 만들어 DB에 둔다 (바뀌면 휴대폰이 다시 등록해야 함) */
function loadKeys(db: DatabaseSync): VapidKeys {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'vapid'").get() as { value?: string } | undefined;
  if (row?.value) return JSON.parse(row.value);
  const keys = webpush.generateVAPIDKeys();
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
  return keys;
}
