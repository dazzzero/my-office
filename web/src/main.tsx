import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { api, isRemote } from './api.ts';
import { watchInstall } from './install.ts';
import { registerServiceWorker, syncPush } from './push.ts';
import { startOffice, useOffice } from './store.ts';
import './styles.css';

watchInstall();
void registerServiceWorker();
void startOffice().then(async () => {
  // 휴대폰: 알림을 이미 허용했으면 열 때마다 푸시 등록을 맞춰 둔다
  if (!isRemote || useOffice.getState().needPair) return;
  const { pushKey } = await api<{ pushKey: string }>('GET', '/api/mobile');
  await syncPush(pushKey);
}).catch(() => {});
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
