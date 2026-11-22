import { Suspense, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { MotionConfig } from 'motion/react';
import { Header, LiveStatus, Toasts } from './Header';
import { LiveProvider } from './live';
import type { Account } from './api';
import { Chat } from './Intelligence';
import { ChatWindow } from './ChatWindow';
import { ViewProvider } from './filters/ViewContext';

export default function Console({user}:{user:Account}) {
  const [chatDock, setChatDock] = useState<HTMLDivElement | null>(null);
  return <MotionConfig reducedMotion="user"><LiveProvider>
    <ViewProvider key={user.login} login={user.login}><Header user={user}/><LiveStatus/>
    <Suspense fallback={<main className="container waiting" role="status">Загружаем пульт…</main>}>
      <Outlet context={setChatDock}/>
    </Suspense>
    <ChatWindow dock={chatDock}><Chat/></ChatWindow>
    </ViewProvider>
    <Toasts/>
  </LiveProvider></MotionConfig>;
}
