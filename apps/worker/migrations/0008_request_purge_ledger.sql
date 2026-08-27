CREATE TABLE request_purge_ledger (
  request_db_generation TEXT NOT NULL,
  case_id TEXT NOT NULL CHECK (length(case_id) = 36),
  purged_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  PRIMARY KEY (request_db_generation, case_id)
) STRICT;

CREATE TRIGGER request_purge_ledger_no_update
BEFORE UPDATE ON request_purge_ledger
BEGIN
  SELECT RAISE(ABORT, 'request_purge_ledger is append-only');
END;

CREATE TRIGGER request_purge_ledger_no_delete
BEFORE DELETE ON request_purge_ledger
BEGIN
  SELECT RAISE(ABORT, 'request_purge_ledger is append-only');
END;
