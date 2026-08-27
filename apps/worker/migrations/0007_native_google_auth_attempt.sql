CREATE TABLE native_google_auth_attempt (
  id TEXT PRIMARY KEY NOT NULL,
  application_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX native_google_auth_attempt_expiry_idx
  ON native_google_auth_attempt (expires_at);
