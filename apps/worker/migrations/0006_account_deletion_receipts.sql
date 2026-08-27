CREATE TABLE account_deletion_receipt (
  operation_hash TEXT NOT NULL PRIMARY KEY CHECK (length(operation_hash) = 64),
  subject_hash TEXT NOT NULL CHECK (length(subject_hash) = 64),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  completed_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX account_deletion_receipt_expires_at_idx
ON account_deletion_receipt(expires_at);
