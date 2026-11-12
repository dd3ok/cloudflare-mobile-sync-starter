ALTER TABLE request_case
ADD COLUMN target_account_hash TEXT
  CHECK (target_account_hash IS NULL OR length(target_account_hash) = 64);
