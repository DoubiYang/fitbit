import { createRequestDeps, requestCookieHeader } from '../../src/server/auth/runtime';
import { loadConfig } from '../../src/server/config/env';
import { getCurrentUser } from '../../src/server/session/current-user';
import { civilDate } from '../../src/server/time/civil-date';
import { SettingsPanel } from '../../src/ui/settings/sleep-goal-settings';
import { StatusPage } from '../../src/ui/shell/status-page';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const config = loadConfig();
  const deps = config.kind === 'oauth' ? await createRequestDeps() : { config };
  const user = await getCurrentUser({
    config,
    store: deps.store,
    cookieHeader: config.kind === 'oauth' ? await requestCookieHeader() : undefined,
  });

  if (user.mode === 'unconfigured') {
    return (
      <StatusPage
        eyebrow="节律"
        title="本地授权尚未配置"
        body="Google Health 或数据库配置不完整。睡眠目标和身体年龄资料需要完整的授权配置。"
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
        body="连接 Google Health 后才能设置睡眠目标、身体年龄资料和时区。"
        actionHref="/rhythm/account"
        actionLabel="前往账户"
      />
    );
  }

  if (user.mode === 'demo') {
    return (
      <SettingsPanel
        initialGoalMinutes={null}
        hasTimeZone={false}
        initialBodyAgeProfile={{ birthDate: null, referenceSex: null }}
        bodyAgeEditable={false}
        includeTimeZoneBootstrap={false}
      />
    );
  }

  const now = new Date();
  const zone = deps.store
    ? await deps.store.healthMetrics.lookupTimeZoneHistory({ userId: user.id, at: now.toISOString() })
    : undefined;
  const civil = zone ? civilDate(now, zone.ianaTimeZone) : '9999-12-31';
  const goal = deps.store
    ? await deps.store.healthMetrics.lookupSleepGoal({ userId: user.id, civilDate: civil })
    : undefined;
  const bodyAgeProfile = deps.store
    ? await deps.store.healthMetrics.getBodyAgeProfile({ userId: user.id })
    : undefined;

  return (
    <SettingsPanel
      initialGoalMinutes={goal?.goalMinutes ?? null}
      hasTimeZone={Boolean(zone)}
      initialBodyAgeProfile={{
        birthDate: bodyAgeProfile?.birthDate ?? null,
        referenceSex: bodyAgeProfile?.referenceSex ?? null,
      }}
    />
  );
}
