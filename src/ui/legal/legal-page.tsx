import type { ReactNode } from 'react';

import { AppShell } from '../shell/app-shell';

import styles from './legal-page.module.css';

type LegalPageProps = {
  title: string;
  paragraphs?: readonly string[];
  sections?: readonly { title: string; content: ReactNode }[];
  eyebrow?: string;
  brandIcon?: boolean;
  links?: ReactNode;
  returnHref: string;
  returnLabel: string;
};

export function LegalPage({ title, paragraphs, sections, eyebrow = '节律 · 账户', brandIcon, links, returnHref, returnLabel }: LegalPageProps) {
  return (
    <AppShell active="account">
      <main className={styles.page}>
        <header className={styles.header}>
          {brandIcon && <img src="/rhythm/icon.svg" width={64} height={64} alt="" />}
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1 className={styles.title}>{title}</h1>
        </header>

        <section className={styles.reading} aria-label={title}>
          {paragraphs?.map((paragraph) => (
            <p className={styles.paragraph} key={paragraph}>
              {paragraph}
            </p>
          ))}
          {sections?.map((section) => (
            <div className={styles.section} key={section.title}>
              <h2>{section.title}</h2>
              <p className={styles.paragraph}>{section.content}</p>
            </div>
          ))}
        </section>

        <nav className={styles.return} aria-label="相关页面">
          {links}
          <a href={returnHref}>
            {returnLabel}
          </a>
        </nav>
      </main>
    </AppShell>
  );
}
