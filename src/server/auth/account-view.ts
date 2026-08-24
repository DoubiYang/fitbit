import type { AuthErrorCode, ConnectionRow } from './types';
import { AUTH_ERROR_CODES } from './types';
import { canWriteNutrition, grantedScopeLabels, missingCoreDashboard, missingScopeLabels } from './scopes';

export type AccountView =
  | { state: 'unconfigured' }
  | { state: 'unauthenticated' }
  | {
      state: 'connected';
      connectedAt: string;
      scopeLabels: string[];
      canWriteNutrition: boolean;
      testingExpiryNote: boolean;
    }
  | {
      state: 'partial';
      connectedAt: string;
      scopeLabels: string[];
      missingLabels: string[];
      missingCore: boolean;
      canWriteNutrition: boolean;
      testingExpiryNote: boolean;
    }
  | { state: 'expired'; testingExpiryNote: boolean }
  | { state: 'callback_error'; code: AuthErrorCode };

const ERROR_COPY: Record<AuthErrorCode, string> = {
  not_configured: '本地授权尚未配置。',
  access_denied: '已取消 Google 授权。',
  invalid_state: '这次授权请求无效或已过期，请重试。',
  transaction_expired: '授权会话已过期，请重新连接。',
  missing_refresh_token: 'Google 未返回长期授权，请重新连接。',
  identity_mismatch: '这个 Google Health 账号与当前账户不匹配。',
  identity_unavailable: '无法读取 Google Health 身份，请稍后重试。',
  token_exchange_failed: '无法完成 Google 授权，请稍后重试。',
  origin_rejected: '请求来源不受信任。',
  unauthorized: '请先登录。',
};

export function sanitizeAuthError(value: string | undefined): AuthErrorCode | undefined {
  if (!value) {
    return undefined;
  }
  return AUTH_ERROR_CODES.find((code) => code === value);
}

export function authErrorMessage(code: AuthErrorCode): string {
  return ERROR_COPY[code];
}

export function buildAccountView(input: {
  mode: 'demo' | 'unconfigured' | 'unauthenticated' | 'oauth';
  connection?: ConnectionRow;
  authError?: string;
  now?: Date;
}): AccountView {
  const authError = sanitizeAuthError(input.authError);
  if (authError) {
    return { state: 'callback_error', code: authError };
  }
  if (input.mode === 'unconfigured' || input.mode === 'demo') {
    return { state: 'unconfigured' };
  }
  if (input.mode === 'unauthenticated' || !input.connection || input.connection.status === 'disconnected') {
    return { state: 'unauthenticated' };
  }

  const testingExpiryNote = true;
  const now = input.now ?? new Date();
  if (
    input.connection.status === 'expired' ||
    (input.connection.refreshTokenExpiresAt && input.connection.refreshTokenExpiresAt.getTime() <= now.getTime())
  ) {
    return { state: 'expired', testingExpiryNote };
  }

  const connectedAt = input.connection.connectedAt.toISOString();
  const scopeLabels = grantedScopeLabels(input.connection.grantedScopes);
  if (input.connection.status === 'partial') {
    return {
      state: 'partial',
      connectedAt,
      scopeLabels,
      missingLabels: missingScopeLabels(input.connection.grantedScopes),
      missingCore: missingCoreDashboard(input.connection.grantedScopes),
      canWriteNutrition: canWriteNutrition(input.connection.grantedScopes),
      testingExpiryNote,
    };
  }

  return {
    state: 'connected',
    connectedAt,
    scopeLabels,
    canWriteNutrition: canWriteNutrition(input.connection.grantedScopes),
    testingExpiryNote,
  };
}
