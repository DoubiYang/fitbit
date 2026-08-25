import { loadConfig } from '../src/server/config/env';
import { buildTodayViewForUser } from '../src/server/dashboard/today-response';
import { createRequestDeps, requestCookieHeader } from '../src/server/auth/runtime';
import { getCurrentUser } from '../src/server/session/current-user';
import { TodayDashboard } from '../src/ui/dashboard/today-dashboard';
import { StatusPage } from '../src/ui/shell/status-page';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const config = loadConfig();
  const deps = config.kind === 'demo' ? { config } : await createRequestDeps();
  const user =
    config.kind === 'demo'
      ? await getCurrentUser({ config })
      : await getCurrentUser({
          config,
          store: deps.store,
          cookieHeader: await requestCookieHeader(),
        });
  const view = await buildTodayViewForUser(user, new Date().toISOString(), deps);

  if (user.mode === 'unconfigured') {
    return (
      <StatusPage
        eyebrow="节律"
        title="本地授权尚未配置"
        body="Google Health 或数据库配置不完整。演示数据不会在这种模式下显示。"
        actionHref="/rhythm/account"
        actionLabel="查看账户说明"
      />
    );
  }

  if (user.mode === 'unauthenticated') {
    return (
      <StatusPage
        eyebrow="节律"
        title="尚未登录"
        body="连接 Google Health 后才会显示你的指标。这里不会回退到演示用户。"
        actionHref="/rhythm/account"
        actionLabel="前往账户"
      />
    );
  }

  if (!view) {
    return (
      <StatusPage
        eyebrow="节律"
        title="无法显示今日视图"
        body="当前没有可展示的用户会话。"
        actionHref="/rhythm/account"
        actionLabel="前往账户"
      />
    );
  }

  return <TodayDashboard view={view} variant={user.mode === 'demo' ? 'demo' : 'oauth'} />;
}
