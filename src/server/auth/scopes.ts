export const REQUESTED_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.nutrition.readonly',
  'https://www.googleapis.com/auth/googlehealth.nutrition.writeonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly',
  'https://www.googleapis.com/auth/googlehealth.location.readonly',
  'https://www.googleapis.com/auth/googlehealth.ecg.readonly',
  'https://www.googleapis.com/auth/googlehealth.irn.readonly',
] as const;

export const CORE_DASHBOARD_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
] as const;

export const NUTRITION_WRITE_SCOPE = 'https://www.googleapis.com/auth/googlehealth.nutrition.writeonly';

const SCOPE_LABELS: Record<string, string> = {
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly': '睡眠',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly': '生命体征',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly': '活动与训练',
  'https://www.googleapis.com/auth/googlehealth.nutrition.readonly': '营养读取',
  'https://www.googleapis.com/auth/googlehealth.nutrition.writeonly': '营养写回',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly': '档案',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly': '设置与时区',
  'https://www.googleapis.com/auth/googlehealth.location.readonly': '运动轨迹',
  'https://www.googleapis.com/auth/googlehealth.ecg.readonly': '心电图',
  'https://www.googleapis.com/auth/googlehealth.irn.readonly': '心律不齐通知',
};

export type ConnectionStatus = 'disconnected' | 'active' | 'partial' | 'expired';

export function normalizeGrantedScopes(raw: string | string[] | undefined): string[] {
  const values = Array.isArray(raw) ? raw : (raw ?? '').split(/[,\s]+/);
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) {
      unique.add(trimmed);
    }
  }
  return [...unique];
}

export function missingRequestedScopes(granted: string[]): string[] {
  const grantedSet = new Set(granted);
  return REQUESTED_SCOPES.filter((scope) => !grantedSet.has(scope));
}

export function missingScopeLabels(granted: string[]): string[] {
  return missingRequestedScopes(granted).map((scope) => SCOPE_LABELS[scope] ?? scope);
}

export function grantedScopeLabels(granted: string[]): string[] {
  return granted.flatMap((scope) => (SCOPE_LABELS[scope] ? [SCOPE_LABELS[scope]] : []));
}

export function hasAllRequestedScopes(granted: string[]): boolean {
  return missingRequestedScopes(granted).length === 0;
}

export function missingCoreDashboard(granted: string[]): boolean {
  const grantedSet = new Set(granted);
  return CORE_DASHBOARD_SCOPES.some((scope) => !grantedSet.has(scope));
}

export function canWriteNutrition(granted: string[]): boolean {
  return granted.includes(NUTRITION_WRITE_SCOPE);
}

export function connectionStatusFromGrant(input: {
  granted: string[];
  hasRefreshToken: boolean;
  refreshTokenExpiresAt: Date | undefined;
  now: Date;
}): ConnectionStatus {
  if (!input.hasRefreshToken) {
    return 'expired';
  }
  if (input.refreshTokenExpiresAt && input.refreshTokenExpiresAt.getTime() <= input.now.getTime()) {
    return 'expired';
  }
  if (!hasAllRequestedScopes(input.granted)) {
    return 'partial';
  }
  return 'active';
}

export function requestedScopeString(): string {
  return REQUESTED_SCOPES.join(' ');
}
