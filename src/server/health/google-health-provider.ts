import { emptyUserHealthRecords, type HealthDateRange, type HealthProvider, type UserHealthRecords } from './provider';

type GoogleHealthConfiguration = {
  clientId: string | undefined;
  clientSecret: string | undefined;
};

export class IntegrationUnavailableError extends Error {
  readonly code = 'integration_unavailable';

  constructor(message = 'Google Health integration is not configured for this environment.') {
    super(message);
    this.name = 'IntegrationUnavailableError';
  }
}

export class GoogleHealthProvider implements HealthProvider {
  readonly capabilities = { mode: 'unavailable' as const, canSync: false };

  constructor(private readonly configuration: GoogleHealthConfiguration) {}

  async listRecords(_userId: string, _range: HealthDateRange): Promise<UserHealthRecords> {
    if (!this.configuration.clientId || !this.configuration.clientSecret) {
      throw new IntegrationUnavailableError();
    }

    // This P1 foundation must never fabricate a successful external sync.
    throw new IntegrationUnavailableError('Google Health sync is intentionally disabled until the OAuth slice is complete.');
  }
}

export function unavailableGoogleHealthRecords(): UserHealthRecords {
  return emptyUserHealthRecords();
}
