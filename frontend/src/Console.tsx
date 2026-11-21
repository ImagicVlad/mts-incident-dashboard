import { Outlet } from 'react-router-dom';
import { MotionConfig } from 'motion/react';
import { Header, LiveStatus, Toasts } from './Header';
import { LiveProvider } from './live';
import type { Account } from './api';

export default function Console({user}:{user:Account}) {
  return <MotionConfig reducedMotion="user"><LiveProvider>
    <Header user={user}/><LiveStatus/><Outlet/><Toasts/>
  </LiveProvider></MotionConfig>;
}
