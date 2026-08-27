CREATE TABLE mobile_auth_handoff (
  id TEXT NOT NULL PRIMARY KEY,
  audience TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_hash TEXT,
  session_cookie TEXT,
  session_expires_at TEXT,
  session_id TEXT REFERENCES session(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ready_at INTEGER,
  consumed_at INTEGER,
  CHECK (length(id) = 64),
  CHECK (length(code_challenge) = 43),
  CHECK (
    (code_hash IS NULL AND session_cookie IS NULL AND session_expires_at IS NULL AND session_id IS NULL AND user_id IS NULL AND ready_at IS NULL AND consumed_at IS NULL)
    OR
  (code_hash IS NOT NULL AND session_cookie IS NOT NULL AND session_expires_at IS NOT NULL AND session_id IS NOT NULL AND user_id IS NOT NULL AND ready_at IS NOT NULL AND consumed_at IS NULL)
  OR
  (code_hash IS NULL AND session_cookie IS NULL AND session_expires_at IS NOT NULL AND session_id IS NOT NULL AND user_id IS NOT NULL AND ready_at IS NOT NULL AND consumed_at IS NOT NULL)
  )
);

CREATE INDEX mobile_auth_handoff_expires_at_idx
  ON mobile_auth_handoff (expires_at);
