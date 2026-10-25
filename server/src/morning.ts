// 아침 루틴: 평일 정해진 시각에 층마다 스탠드업을 연다. 그 시각에 서버가 꺼져 있었으면 그날 처음 켜질 때 연다.
// 바뀐 것도 남은 일도 없는 층은 회의 엔진(openStandup)이 건너뛴다.
import type { DatabaseSync } from 'node:sqlite';
import type { MorningConfig } from '../../shared/src/config.ts';
import type { Meeting, MorningStatus } from '../../shared/src/meetings.ts';
import { ymd, type MeetingManager } from './meetings.ts';

const LAST_KEY = 'morning_last';

export interface MorningOptions {
  db: DatabaseSync;
  config: MorningConfig;
  meetings: Pick<MeetingManager, 'openStandup'>;
  now?: () => number;
  onChange?: () => void;
  log?: (msg: string) => void;
}

export class MorningRoutine {
  private readonly db: DatabaseSync;
  private readonly config: MorningConfig;
  private readonly meetings: MorningOptions['meetings'];
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly log: (msg: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(o: MorningOptions) {
    this.db = o.db;
    this.config = o.config;
    this.meetings = o.meetings;
    this.now = o.now ?? Date.now;
    this.onChange = o.onChange ?? (() => {});
    this.log = o.log ?? (() => {});
  }

  /** 1분마다 확인. 켜자마자 한 번 (놓친 날 보충) */
  start(): void {
    this.timer = setInterval(() => void this.check(), 60_000);
    this.timer.unref?.();
    this.first = setTimeout(() => void this.check(), 5_000);
    this.first.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
  }

  get lastDate(): string | null {
    return ((this.db.prepare('SELECT value FROM meta WHERE key = ?').get(LAST_KEY) as { value?: string } | undefined)?.value) ?? null;
  }

  /** 오늘 실행할 때가 됐으면 실행. 실행했으면 true */
  async check(): Promise<boolean> {
    if (!this.config.enabled || this.running) return false;
    const now = this.now();
    if (!this.config.weekdays.includes(new Date(now).getDay())) return false;
    if (now < this.at(now) || this.lastDate === ymd(now)) return false;
    await this.run({ scheduled: true });
    return true;
  }

  /**
   * 층마다 스탠드업 열기. 바뀐 것 없는 층은 건너뛴다.
   * scheduled(정기 실행)일 때만 "오늘 했음"을 기록한다 → 패널의 "지금 실행"을 눌러도 그날 정기 실행은 그대로 돈다
   * (그사이 바뀐 게 없으면 건너뛰므로 사용량이 거의 안 든다). 회의가 실패해도 다시 시도하지 않는다 (사용량이 계속 새지 않게).
   */
  async run(o: { scheduled?: boolean } = {}): Promise<Meeting[]> {
    if (this.running) return [];
    this.running = true;
    const date = ymd(this.now());
    // 먼저 기록해 둬야 도중에 다시 확인해도 두 번 돌지 않는다
    if (o.scheduled) this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(LAST_KEY, date);
    this.onChange();
    const out: Meeting[] = [];
    try {
      for (const floor of this.config.floors) {
        try {
          out.push(await this.meetings.openStandup(floor, { routineDate: date }));
        } catch (e) {
          this.log(`아침 루틴 ${floor}층: ${(e as Error).message}`);
        }
      }
      const opened = out.filter(m => m.status !== 'skipped').length;
      this.log(`☀️ 아침 루틴 (${date}): 스탠드업 ${opened}개 · 건너뜀 ${out.length - opened}개`);
    } finally {
      this.running = false;
      this.onChange();
    }
    return out;
  }

  status(): MorningStatus {
    return { enabled: this.config.enabled, time: this.config.time, nextAt: this.nextAt(), lastDate: this.lastDate };
  }

  /** 그날의 실행 시각 */
  private at(ts: number): number {
    const [h, m] = this.config.time.split(':').map(Number);
    const d = new Date(ts);
    d.setHours(h || 0, m || 0, 0, 0);
    return d.getTime();
  }

  private nextAt(): number | null {
    if (!this.config.enabled || !this.config.weekdays.length) return null;
    const now = this.now();
    const done = this.lastDate === ymd(now);
    for (let i = 0; i < 8; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      if (!this.config.weekdays.includes(d.getDay())) continue;
      if (i === 0 && done) continue;
      // 오늘 시각이 지났는데 아직 안 했으면 곧 (1분 안에) 실행
      return i === 0 ? Math.max(this.at(d.getTime()), now) : this.at(d.getTime());
    }
    return null;
  }
}
