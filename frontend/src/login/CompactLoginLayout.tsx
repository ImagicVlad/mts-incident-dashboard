import type { ReactNode } from 'react';
import './compact-login.css';

export default function CompactLoginLayout({ children }: { children: ReactNode }) {
  return (
    <main className="compact-login">
      <div className="compact-login-sheet">
        <img className="compact-login-mark" src="/mts-logo.svg" width="36" height="36" alt="МТС" />
        {children}
      </div>
    </main>
  );
}
