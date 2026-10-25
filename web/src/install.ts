// 앱 설치(PWA): 크롬이 "설치할 수 있음"을 알려 주면 잡아 두었다가, 버튼을 누를 때 설치 창을 띄운다.
import { create } from 'zustand';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'myoffice-install-dismissed';

/** 홈 화면 아이콘으로 열린 앱인지 (브라우저 탭이 아니라) */
export const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches;

export const useInstall = create<{ prompt: InstallPrompt | null; installed: boolean; dismissed: boolean }>(() => ({
  prompt: null,
  installed: isInstalled(),
  dismissed: localStorage.getItem(DISMISS_KEY) === '1',
}));

/** 앱이 뜨기 전에 불러야 크롬의 알림을 놓치지 않는다 */
export function watchInstall(): void {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); // 크롬 기본 안내 대신 우리 버튼으로
    useInstall.setState({ prompt: e as InstallPrompt });
  });
  window.addEventListener('appinstalled', () => useInstall.setState({ installed: true, prompt: null }));
}

/** 설치 창 띄우기. 크롬이 아직 준비가 안 됐으면 false (메뉴로 설치하라고 안내) */
export async function install(): Promise<boolean> {
  const p = useInstall.getState().prompt;
  if (!p) return false;
  await p.prompt();
  const { outcome } = await p.userChoice;
  useInstall.setState({ prompt: null, ...(outcome === 'accepted' ? { installed: true } : {}) });
  return true;
}

export function dismissInstall(): void {
  localStorage.setItem(DISMISS_KEY, '1');
  useInstall.setState({ dismissed: true });
}
