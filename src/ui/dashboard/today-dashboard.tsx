import type { HomepageTodayView } from '../../server/dashboard/build-today';
import { AppShell } from '../shell/app-shell';

import { EditorialHomepage } from './editorial-homepage';

/**
 * The homepage intentionally accepts the browser allowlist, not TodayView.
 * That makes it impossible for JSX here to accidentally expose evidence,
 * zone thresholds, raw measurements, or server/user metadata.
 */
export function TodayDashboard({
  view,
  variant = 'demo',
}: {
  view: HomepageTodayView;
  variant?: 'demo' | 'oauth';
}) {
  return (
    <AppShell active="today">
      <EditorialHomepage view={view} variant={variant} />
    </AppShell>
  );
}
