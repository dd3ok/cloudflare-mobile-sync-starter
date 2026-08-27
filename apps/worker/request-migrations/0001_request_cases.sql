CREATE TABLE request_case (
  case_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(case_id) = 36),
  scope TEXT NOT NULL
    CHECK (length(scope) BETWEEN 1 AND 64),
  kind TEXT NOT NULL
    CHECK (kind IN ('account_deletion', 'privacy_request', 'inquiry')),
  privacy_action TEXT
    CHECK (
      privacy_action IS NULL
      OR privacy_action IN (
        'access',
        'correction',
        'restriction',
        'withdrawal',
        'objection',
        'identity_issue'
      )
    ),
  subject_fingerprint TEXT
    CHECK (subject_fingerprint IS NULL OR length(subject_fingerprint) = 64),
  request_text TEXT,
  response_text TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'completed', 'rejected')),
  outcome_code TEXT
    CHECK (outcome_code IS NULL OR length(outcome_code) BETWEEN 1 AND 64),
  locale TEXT NOT NULL
    CHECK (locale IN ('ko', 'en')),
  notice_version TEXT NOT NULL
    CHECK (length(notice_version) BETWEEN 1 AND 32),
  receipt_digest TEXT
    CHECK (receipt_digest IS NULL OR length(receipt_digest) = 64),
  receipt_version INTEGER NOT NULL DEFAULT 1
    CHECK (receipt_version > 0),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  purge_after INTEGER,
  CHECK (
    (kind = 'privacy_request' AND privacy_action IS NOT NULL)
    OR (kind != 'privacy_request' AND privacy_action IS NULL)
  ),
  CHECK (
    (status = 'pending' AND closed_at IS NULL AND purge_after IS NULL)
    OR (status != 'pending' AND closed_at IS NOT NULL AND purge_after IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX request_case_receipt_digest_idx
  ON request_case(receipt_digest)
  WHERE receipt_digest IS NOT NULL;

CREATE UNIQUE INDEX request_case_open_deletion_subject_idx
  ON request_case(subject_fingerprint)
  WHERE kind = 'account_deletion'
    AND status = 'pending'
    AND subject_fingerprint IS NOT NULL;

CREATE INDEX request_case_pending_created_idx
  ON request_case(status, created_at);

CREATE INDEX request_case_purge_after_idx
  ON request_case(purge_after)
  WHERE purge_after IS NOT NULL;

CREATE TABLE request_evidence (
  case_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(case_id) = 36),
  kind TEXT NOT NULL
    CHECK (kind IN ('account_deletion', 'privacy_request', 'inquiry')),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  outcome_code TEXT
    CHECK (outcome_code IS NULL OR length(outcome_code) BETWEEN 1 AND 64),
  details_purged_at INTEGER,
  retention_policy_version TEXT NOT NULL
    CHECK (length(retention_policy_version) BETWEEN 1 AND 32)
) STRICT;
