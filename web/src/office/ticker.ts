// 움직이는 직원이 있을 때만 초당 30번 화면을 갱신한다. 아무도 안 움직이면 갱신 0.
import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';

const active = new Set<string>();
let kick: (() => void) | null = null;

export const activity = {
  start(id: string) {
    active.add(id);
    kick?.();
  },
  stop(id: string) {
    active.delete(id);
  },
  get count() {
    return active.size;
  },
};

export function Ticker() {
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => {
    kick = () => invalidate();
    const timer = setInterval(() => {
      if (active.size && !document.hidden) invalidate();
    }, 1000 / 30);
    return () => {
      clearInterval(timer);
      kick = null;
    };
  }, [invalidate]);
  return null;
}
