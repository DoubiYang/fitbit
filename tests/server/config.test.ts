import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, parseEncryptionKey, publicPath, redirectUri } from '../../src/server/config/env';

const validKey = Buffer.alloc(32, 9).toString('base64');
const otherKey = Buffer.alloc(32, 8).toString('base64');

const completeEnv = {
  DATABASE_URL: 'postgresql://rhythm:x@db:5432/rhythm',
  GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
  GOOGLE_HEALTH_CLIENT_SECRET: 'client-secret',
  TOKEN_ENCRYPTION_KEY: validKey,
  SYNC_SECRET: '2e9e56ce2ee5b4374d8e5bcf8df0f32a3f1ab6789e1b7f4aa03edfbd827a3045',
  APP_ORIGIN: 'http://localhost:3000',
};

test('empty env is demo mode', () => {
  assert.deepEqual(loadConfig({}), { kind: 'demo', appOrigin: 'http://localhost:3000' });
});

test('APP_ORIGIN alone does not leave demo mode', () => {
  assert.equal(loadConfig({ APP_ORIGIN: 'http://localhost:3000' }).kind, 'demo');
});

test('partial secrets are unconfigured and fail closed', () => {
  const config = loadConfig({
    GOOGLE_HEALTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    APP_ORIGIN: 'https://doubiyang.com',
  });
  assert.equal(config.kind, 'unconfigured');
  if (config.kind === 'unconfigured') {
    assert.equal(config.appOrigin, 'https://doubiyang.com');
  }
});

test('invalid encryption key is unconfigured', () => {
  const config = loadConfig({ ...completeEnv, TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') });
  assert.equal(config.kind, 'unconfigured');
});

test('complete secrets load oauth config with /rhythm redirect', () => {
  const config = loadConfig(completeEnv);
  assert.equal(config.kind, 'oauth');
  if (config.kind !== 'oauth') {
    return;
  }
  assert.equal(config.appOrigin, 'http://localhost:3000');
  assert.equal(config.appBasePath, '/rhythm');
  assert.equal(config.syncSecret, completeEnv.SYNC_SECRET);
  assert.equal(redirectUri(config), 'http://localhost:3000/rhythm/api/auth/google/callback');
  assert.equal(publicPath(config.appOrigin, '/account'), 'http://localhost:3000/rhythm/account');
  assert.equal(parseEncryptionKey(validKey).length, 32);
});

test('missing sync secret keeps oauth and disables the scheduler secret', () => {
  const { SYNC_SECRET: _syncSecret, ...withoutSyncSecret } = completeEnv;
  const config = loadConfig(withoutSyncSecret);
  assert.equal(config.kind, 'oauth');
  if (config.kind === 'oauth') {
    assert.equal(config.syncSecret, undefined);
  }
});

test('origin with a path is rejected', () => {
  const config = loadConfig({ ...completeEnv, APP_ORIGIN: 'http://localhost:3000/rhythm' });
  assert.equal(config.kind, 'unconfigured');
});

test('previous key must differ from current key', () => {
  const config = loadConfig({ ...completeEnv, TOKEN_ENCRYPTION_KEY_PREVIOUS: validKey });
  assert.equal(config.kind, 'unconfigured');
});

test('accepts a distinct previous key', () => {
  const config = loadConfig({ ...completeEnv, TOKEN_ENCRYPTION_KEY_PREVIOUS: otherKey });
  assert.equal(config.kind, 'oauth');
});

test('builds DATABASE_URL from postgres parts when the URL is omitted', () => {
  const config = loadConfig({
    POSTGRES_USER: 'rhythm',
    POSTGRES_PASSWORD: 's3cret',
    POSTGRES_DB: 'rhythm',
    POSTGRES_HOST: 'db',
    GOOGLE_HEALTH_CLIENT_ID: completeEnv.GOOGLE_HEALTH_CLIENT_ID,
    GOOGLE_HEALTH_CLIENT_SECRET: completeEnv.GOOGLE_HEALTH_CLIENT_SECRET,
    TOKEN_ENCRYPTION_KEY: validKey,
    SYNC_SECRET: completeEnv.SYNC_SECRET,
    APP_ORIGIN: 'http://localhost:3000',
  });
  assert.equal(config.kind, 'oauth');
  if (config.kind === 'oauth') {
    assert.equal(config.databaseUrl, 'postgresql://rhythm:s3cret@db:5432/rhythm');
  }
});
