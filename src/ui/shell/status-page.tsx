export function StatusPage(input: { title: string; body: string; actionHref: string; actionLabel: string; eyebrow?: string }) {
  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <p className="eyebrow">{input.eyebrow ?? '节律'}</p>
        <div className="dashboard-header__title-row">
          <h1>{input.title}</h1>
        </div>
        <p className="lede">{input.body}</p>
        <p>
          <a href={input.actionHref}>{input.actionLabel}</a>
        </p>
      </header>
    </main>
  );
}
