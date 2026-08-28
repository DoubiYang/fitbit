import { AppShell } from '../shell/app-shell';

import styles from './legal-page.module.css';

type LegalPageProps = {
  title: string;
  paragraphs: readonly string[];
  returnHref: string;
  returnLabel: string;
};

export function LegalPage({ title, paragraphs, returnHref, returnLabel }: LegalPageProps) {
  return (
    <AppShell active="account">
      <main className={styles.page}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>节律 · 账户</p>
          <h1 className={styles.title}>{title}</h1>
        </header>

        <section className={styles.reading} aria-label={title}>
          {paragraphs.map((paragraph) => (
            <p className={styles.paragraph} key={paragraph}>
              {paragraph}
            </p>
          ))}
        </section>

        <p className={styles.return}>
          <a className={styles.returnLink} href={returnHref}>
            {returnLabel}
          </a>
        </p>
      </main>
    </AppShell>
  );
}
