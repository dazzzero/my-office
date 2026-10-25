// 연결된 휴대폰. PC 화면의 QR(일회용 연결 코드)을 찍으면 그 기기 전용 키를 준다.
// 키는 해시로만 저장하고, PC에서 언제든 연결을 끊을 수 있다.
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PREFS, type Device, type MobilePrefs } from '../../shared/src/mobile.ts';
import { TaskError } from './tasks.ts';

type Row = Record<string, unknown>;

const CODE_TTL = 10 * 60_000;
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export class Devices {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private codes = new Map<string, number>();
  private seen = new Map<number, number>();

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /** PC 화면에서 QR로 보여 줄 일회용 연결 코드 (10분) */
  pairCode(): { code: string; expiresAt: number } {
    const t = this.now();
    for (const [c, exp] of this.codes) if (exp < t) this.codes.delete(c);
    const code = randomBytes(18).toString('base64url');
    this.codes.set(code, t + CODE_TTL);
    return { code, expiresAt: t + CODE_TTL };
  }

  /** 휴대폰이 코드를 내면 기기 키를 준다. 코드는 한 번만 쓸 수 있다 */
  claim(code: string, name: string): { token: string; device: Device } {
    const exp = this.codes.get(code);
    this.codes.delete(code);
    if (!exp || exp < this.now()) throw new TaskError('연결 코드가 없거나 만료됐어요. PC에서 QR을 새로 띄워 찍어 주세요');
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO devices (name, token_hash, prefs, created_at, last_seen) VALUES (?, ?, ?, ?, ?)')
      .run(String(name || '휴대폰').slice(0, 40), hashOf(token), JSON.stringify(DEFAULT_PREFS), t, t);
    return { token, device: this.get(Number(lastInsertRowid))! };
  }

  /** 기기 키 확인. 맞으면 그 기기 */
  verify(token: string | undefined): Device | null {
    if (!token) return null;
    const r = this.db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(hashOf(token)) as Row | undefined;
    if (!r) return null;
    const id = Number(r.id);
    const t = this.now();
    // 마지막 접속 시각은 1분에 한 번만 기록
    if (t - (this.seen.get(id) ?? 0) > 60_000) {
      this.seen.set(id, t);
      this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(t, id);
    }
    return toDevice(r);
  }

  get(id: number): Device | null {
    const r = this.db.prepare('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL').get(id) as Row | undefined;
    return r ? toDevice(r) : null;
  }

  list(): Device[] {
    return (this.db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY id').all() as Row[]).map(toDevice);
  }

  revoke(id: number): void {
    const r = this.db.prepare('UPDATE devices SET revoked_at = ?, push = NULL WHERE id = ? AND revoked_at IS NULL').run(this.now(), id);
    if (!r.changes) throw new TaskError('없는 기기입니다');
  }

  update(id: number, patch: { name?: string; push?: PushSubscriptionJSON | null; prefs?: Partial<MobilePrefs> }): Device {
    const d = this.get(id);
    if (!d) throw new TaskError('없는 기기입니다');
    if (patch.name !== undefined) this.db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(String(patch.name).slice(0, 40) || d.name, id);
    if (patch.push !== undefined) {
      if (patch.push && (typeof patch.push.endpoint !== 'string' || !/^https:\/\//.test(patch.push.endpoint) || !patch.push.keys?.p256dh || !patch.push.keys?.auth)) {
        throw new TaskError('푸시 등록 정보가 잘못됐습니다');
      }
      this.db.prepare('UPDATE devices SET push = ? WHERE id = ?').run(patch.push ? JSON.stringify(patch.push) : null, id);
    }
    if (patch.prefs) {
      const prefs = { ...d.prefs };
      for (const k of Object.keys(DEFAULT_PREFS) as (keyof MobilePrefs)[]) if (typeof patch.prefs[k] === 'boolean') prefs[k] = patch.prefs[k]!;
      this.db.prepare('UPDATE devices SET prefs = ? WHERE id = ?').run(JSON.stringify(prefs), id);
    }
    return this.get(id)!;
  }

  /** 이 종류 알림을 받을 기기의 푸시 등록 정보 (kind가 없으면 등록된 기기 전부: 알림 지우기용) */
  pushTargets(kind?: keyof MobilePrefs): { id: number; sub: PushSubscriptionJSON }[] {
    return (this.db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL AND push IS NOT NULL').all() as Row[])
      .filter(r => !kind || toDevice(r).prefs[kind])
      .map(r => ({ id: Number(r.id), sub: JSON.parse(String(r.push)) }));
  }

  /** 푸시 서버가 "더는 없는 구독"이라고 하면 지운다 */
  dropPush(id: number): void {
    this.db.prepare('UPDATE devices SET push = NULL WHERE id = ?').run(id);
  }
}

const toDevice = (r: Row): Device => ({
  id: Number(r.id),
  name: String(r.name),
  createdAt: Number(r.created_at),
  lastSeen: r.last_seen == null ? null : Number(r.last_seen),
  push: r.push != null,
  prefs: { ...DEFAULT_PREFS, ...(r.prefs ? JSON.parse(String(r.prefs)) : {}) },
});
