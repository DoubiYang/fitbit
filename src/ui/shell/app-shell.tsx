import type { ReactNode } from 'react';

import { House, UserRound, Utensils, type LucideIcon } from 'lucide-react';

export type AppShellActive = 'today' | 'account';

type AppShellProps = {
  active: AppShellActive;
  children: ReactNode;
  className?: string;
};

type NavigationItem = {
  href: '/rhythm' | '/rhythm/meals/new' | '/rhythm/account';
  label: string;
  icon: LucideIcon;
  active?: AppShellActive;
};

const navigationItems: readonly NavigationItem[] = [
  { href: '/rhythm', label: '今日', icon: House, active: 'today' },
  { href: '/rhythm/meals/new', label: '餐食', icon: Utensils },
  { href: '/rhythm/account', label: '账户', icon: UserRound, active: 'account' },
];

function ui(name: string): string {
  return `appShell__${name}`;
}

export function AppShell({ active, children, className }: AppShellProps) {
  return (
    <>
      <div className={[ui('shell'), className].filter(Boolean).join(' ')}>{children}</div>
      <nav className={ui('navigation')} aria-label="主要导航">
        {navigationItems.map(({ href, label, icon: Icon, active: itemActive }) => {
          const isActive = active === itemActive;

          return (
            <a
              key={href}
              className={[ui('navigationItem'), isActive ? ui('navigationItemActive') : ''].filter(Boolean).join(' ')}
              href={href}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon aria-hidden="true" size={20} strokeWidth={1.8} />
              <span>{label}</span>
            </a>
          );
        })}
      </nav>
    </>
  );
}
