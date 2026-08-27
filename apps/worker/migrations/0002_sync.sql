PRAGMA foreign_keys = ON;

CREATE TABLE sync_records (
  user_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  updated_at TEXT NOT NULL,
  last_mutation_id TEXT NOT NULL,
  PRIMARY KEY (user_id, collection, record_id),
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
  CHECK (deleted = 0 OR payload IS NULL)
) STRICT;

CREATE TABLE sync_mutations (
  user_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('put', 'delete')),
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'conflict')),
  result_collection TEXT,
  result_record_id TEXT,
  result_revision INTEGER,
  result_cursor INTEGER,
  result_deleted INTEGER CHECK (result_deleted IS NULL OR result_deleted IN (0, 1)),
  result_payload TEXT CHECK (result_payload IS NULL OR json_valid(result_payload)),
  result_updated_at TEXT,
  PRIMARY KEY (user_id, mutation_id),
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
  CHECK ((operation = 'put' AND payload IS NOT NULL) OR (operation = 'delete' AND payload IS NULL))
) STRICT;

CREATE TABLE sync_changes (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  updated_at TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
  UNIQUE (user_id, mutation_id),
  CHECK (deleted = 0 OR payload IS NULL)
) STRICT;

CREATE INDEX sync_changes_user_cursor_idx ON sync_changes(user_id, cursor);

CREATE TRIGGER sync_mutation_finalize
AFTER INSERT ON sync_mutations
FOR EACH ROW
BEGIN
  INSERT INTO sync_records (
    user_id,
    collection,
    record_id,
    revision,
    cursor,
    deleted,
    payload,
    updated_at,
    last_mutation_id
  )
  SELECT
    NEW.user_id,
    NEW.collection,
    NEW.record_id,
    1,
    0,
    CASE WHEN NEW.operation = 'delete' THEN 1 ELSE 0 END,
    CASE WHEN NEW.operation = 'delete' THEN NULL ELSE NEW.payload END,
    NEW.created_at,
    NEW.mutation_id
  WHERE
    (
      NEW.base_revision = 0
      AND NOT EXISTS (
        SELECT 1 FROM sync_records
        WHERE user_id = NEW.user_id
          AND collection = NEW.collection
          AND record_id = NEW.record_id
      )
    )
    OR EXISTS (
      SELECT 1 FROM sync_records
      WHERE user_id = NEW.user_id
        AND collection = NEW.collection
        AND record_id = NEW.record_id
        AND revision = NEW.base_revision
    )
  ON CONFLICT(user_id, collection, record_id) DO UPDATE SET
    revision = sync_records.revision + 1,
    deleted = excluded.deleted,
    payload = excluded.payload,
    updated_at = excluded.updated_at,
    last_mutation_id = excluded.last_mutation_id
  WHERE sync_records.revision = NEW.base_revision;

  INSERT INTO sync_changes (
    user_id,
    collection,
    record_id,
    revision,
    deleted,
    payload,
    updated_at,
    mutation_id
  )
  SELECT
    user_id,
    collection,
    record_id,
    revision,
    deleted,
    payload,
    updated_at,
    NEW.mutation_id
  FROM sync_records
  WHERE user_id = NEW.user_id
    AND collection = NEW.collection
    AND record_id = NEW.record_id
    AND last_mutation_id = NEW.mutation_id;

  UPDATE sync_records
  SET cursor = (
    SELECT cursor FROM sync_changes
    WHERE user_id = NEW.user_id AND mutation_id = NEW.mutation_id
  )
  WHERE user_id = NEW.user_id
    AND collection = NEW.collection
    AND record_id = NEW.record_id
    AND last_mutation_id = NEW.mutation_id;

  UPDATE sync_mutations
  SET
    status = CASE
      WHEN EXISTS (
        SELECT 1 FROM sync_records
        WHERE user_id = NEW.user_id
          AND collection = NEW.collection
          AND record_id = NEW.record_id
          AND last_mutation_id = NEW.mutation_id
      ) THEN 'accepted'
      ELSE 'conflict'
    END,
    result_collection = (
      SELECT collection FROM sync_records
      WHERE user_id = NEW.user_id
        AND collection = NEW.collection
        AND record_id = NEW.record_id
    ),
    result_record_id = (
      SELECT record_id FROM sync_records
      WHERE user_id = NEW.user_id
        AND collection = NEW.collection
        AND record_id = NEW.record_id
    ),
    result_revision = (
      SELECT revision FROM sync_records
      WHERE user_id = NEW.user_id
        AND collection = NEW.collection
        AND record_id = NEW.record_id
    ),
    result_cursor = (
      SELECT cursor FROM sync_records
      WHERE user_id = NEW.user_id
        AND collection = NEW.collection
        AND record_id = NEW.record_id
    ),
    result_deleted = (
      SELECT deleted FROM sync_records
      WHERE user_id = NEW.user_id
        AND collection = NEW.collection
        AND record_id = NEW.record_id
    ),
    result_payload = (
      SELECT payload FROM sync_records
      WHERE user_id = NEW.user_id
        AND collection = NEW.collection
        AND record_id = NEW.record_id
    ),
    result_updated_at = (
      SELECT updated_at FROM sync_records
      WHERE user_id = NEW.user_id
        AND collection = NEW.collection
        AND record_id = NEW.record_id
    )
  WHERE user_id = NEW.user_id AND mutation_id = NEW.mutation_id;
END;

