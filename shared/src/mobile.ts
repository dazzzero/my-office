// 휴대폰 연결: Tailscale 비공개 연결 + 기기별 키 + 푸시 알림.

/** 휴대폰 알림 종류별 켜기/끄기 */
export interface MobilePrefs {
  /** 📋 계획 · ✋ 작업 · 💻 Paseo 결재 */
  approval: boolean;
  /** ☀️ 오늘 할 일 */
  today: boolean;
  /** 🗣️ 회의 끝 */
  meeting: boolean;
  /** ⚠️ 회의·업무 실패 */
  failed: boolean;
}

export const DEFAULT_PREFS: MobilePrefs = { approval: true, today: true, meeting: true, failed: true };

export interface Device {
  id: number;
  name: string;
  createdAt: number;
  lastSeen: number | null;
  /** 푸시 알림을 받을 수 있게 등록됐는지 */
  push: boolean;
  prefs: MobilePrefs;
}

/** 이 PC의 Tailscale 상태 */
export interface TailnetInfo {
  /** Tailscale이 깔려 있고 켜져 있는지 */
  running: boolean;
  /** 이 PC의 주소. 예: mypc.tail1234.ts.net */
  dnsName: string | null;
  /** 이 PC의 Tailscale 계정 */
  login: string | null;
  /** HTTPS 인증서를 쓸 수 있는지 (Tailscale 관리 페이지에서 켜야 함) */
  certs: boolean;
  /** tailscale serve로 마이오피스를 연결해 뒀는지 */
  serving: boolean;
}

export interface MobileStatus {
  tailnet: TailnetInfo;
  /** 휴대폰에서 열 주소 (연결이 다 됐을 때) */
  url: string | null;
  devices: Device[];
}

/** 푸시 알림 한 건 (서비스 워커가 받는 내용) */
export interface PushNote {
  /** clear면 같은 tag 알림을 지운다 (다른 곳에서 처리됨) */
  type: 'show' | 'clear';
  tag: string;
  title?: string;
  body?: string;
  /** 누르면 열 주소 */
  url?: string;
}
