CREATE TABLE users (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE google_health_connections (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES users (id),
  health_user_id TEXT NOT NULL UNIQUE,
  legacy_user_id TEXT UNIQUE,
  token_envelope_ciphertext BYTEA,
  token_envelope_iv BYTEA,
  token_envelope_auth_tag BYTEA,
  encryption_key_version INTEGER,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  granted_scopes TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('disconnected', 'active', 'partial', 'expired')),
  last_error_code TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oauth_transactions (
  id UUID PRIMARY KEY,
  state_hash BYTEA NOT NULL,
  pkce_verifier_ciphertext BYTEA NOT NULL,
  pkce_verifier_iv BYTEA NOT NULL,
  pkce_verifier_auth_tag BYTEA NOT NULL,
  pkce_key_version INTEGER NOT NULL,
  initiating_user_id UUID REFERENCES users (id),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX oauth_transactions_expires_at_idx ON oauth_transactions (expires_at);
