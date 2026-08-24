import { buildAccountView } from '../../src/server/auth/account-view';
import { createRequestDeps, requestCookieHeader } from '../../src/server/auth/runtime';
import { loadConfig } from '../../src/server/config/env';
import { getCurrentUser } from '../../src/server/session/current-user';
import { AccountPanel } from '../../src/ui/account/account-panel';

export const dynamic = 'force-dynamic';

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ auth_error?: string }> | { auth_error?: string } }) {
  const params = await Promise.resolve(searchParams);
  const config = loadConfig();
  const deps = config.kind === 'oauth' ? await createRequestDeps() : { config };
  const user = await getCurrentUser({
    config,
    store: deps.store,
    cookieHeader: config.kind === 'oauth' ? await requestCookieHeader() : undefined,
  });
  const connection = user.mode === 'oauth' && deps.store ? await deps.store.connections.findByUserId(user.id) : undefined;
  return <AccountPanel view={buildAccountView({ mode: user.mode, connection, authError: params.auth_error, now: new Date() })} />;
}
