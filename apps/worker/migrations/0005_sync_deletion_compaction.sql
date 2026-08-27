PRAGMA defer_foreign_keys = true;

DROP TRIGGER sync_mutation_finalize;

-- A normally committed trigger-backed mutation is never left pending. Stop the
-- forward migration rather than silently dropping input from an anomalous row.
CREATE TABLE sync_migration_0005_guard (
  pending_count INTEGER NOT NULL CHECK (pending_count = 0)
) STRICT;

INSERT INTO sync_migration_0005_guard (pending_count)
SELECT COUNT(*) FROM sync_mutations WHERE status = 'pending';

DROP TABLE sync_migration_0005_guard;

-- The request payload is needed only while this INSERT's trigger is running.
-- Rebuild the table so finalized mutation identities can keep their idempotency
-- receipt without retaining a second durable copy of the submitted JSON.
CREATE TABLE sync_mutations_next (
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
  CHECK (
    (
      status = 'pending'
      AND (
        (operation = 'put' AND payload IS NOT NULL)
        OR (operation = 'delete' AND payload IS NULL)
      )
    )
    OR (status IN ('accepted', 'conflict') AND payload IS NULL)
  )
) STRICT;

INSERT INTO sync_mutations_next (
  user_id,
  mutation_id,
  collection,
  record_id,
  operation,
  base_revision,
  payload,
  created_at,
  status,
  result_collection,
  result_record_id,
  result_revision,
  result_cursor,
  result_deleted,
  result_payload,
  result_updated_at
)
SELECT
  user_id,
  mutation_id,
  collection,
  record_id,
  operation,
  base_revision,
  NULL,
  created_at,
  status,
  result_collection,
  result_record_id,
  result_revision,
  result_cursor,
  result_deleted,
  result_payload,
  result_updated_at
FROM sync_mutations;

DROP TABLE sync_mutations;
ALTER TABLE sync_mutations_next RENAME TO sync_mutations;

-- Bring already-deleted records under the new invariant. The mutation identity
-- and status remain reserved for replay, while its record snapshot becomes the
-- current tombstone and no longer contains the deleted payload.
UPDATE sync_mutations
SET
  result_collection = (
    SELECT sync_records.collection
    FROM sync_records
    WHERE sync_records.user_id = sync_mutations.user_id
      AND sync_records.collection = sync_mutations.collection
      AND sync_records.record_id = sync_mutations.record_id
  ),
  result_record_id = (
    SELECT sync_records.record_id
    FROM sync_records
    WHERE sync_records.user_id = sync_mutations.user_id
      AND sync_records.collection = sync_mutations.collection
      AND sync_records.record_id = sync_mutations.record_id
  ),
  result_revision = (
    SELECT sync_records.revision
    FROM sync_records
    WHERE sync_records.user_id = sync_mutations.user_id
      AND sync_records.collection = sync_mutations.collection
      AND sync_records.record_id = sync_mutations.record_id
  ),
  result_cursor = (
    SELECT sync_records.cursor
    FROM sync_records
    WHERE sync_records.user_id = sync_mutations.user_id
      AND sync_records.collection = sync_mutations.collection
      AND sync_records.record_id = sync_mutations.record_id
  ),
  result_deleted = 1,
  result_payload = NULL,
  result_updated_at = (
    SELECT sync_records.updated_at
    FROM sync_records
    WHERE sync_records.user_id = sync_mutations.user_id
      AND sync_records.collection = sync_mutations.collection
      AND sync_records.record_id = sync_mutations.record_id
  )
WHERE EXISTS (
  SELECT 1
  FROM sync_records
  WHERE sync_records.user_id = sync_mutations.user_id
    AND sync_records.collection = sync_mutations.collection
    AND sync_records.record_id = sync_mutations.record_id
    AND sync_records.deleted = 1
);

-- A stale device only needs the latest tombstone. Cursor gaps are an existing
-- protocol property, so removing older versions cannot strand an offline peer.
DELETE FROM sync_changes
WHERE EXISTS (
  SELECT 1
  FROM sync_records
  WHERE sync_records.user_id = sync_changes.user_id
    AND sync_records.collection = sync_changes.collection
    AND sync_records.record_id = sync_changes.record_id
    AND sync_records.deleted = 1
    AND sync_changes.cursor < sync_records.cursor
);

CREATE INDEX sync_changes_user_collection_cursor_idx
ON sync_changes(user_id, collection, cursor);

CREATE INDEX sync_mutations_user_record_idx
ON sync_mutations(user_id, collection, record_id);

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
    payload = NULL,
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

  -- Once a delete is accepted, prior change snapshots and receipt snapshots for
  -- this logical record are superseded by the new payload-free tombstone.
  DELETE FROM sync_changes
  WHERE user_id = NEW.user_id
    AND collection = NEW.collection
    AND record_id = NEW.record_id
    AND cursor < (
      SELECT cursor FROM sync_records
      WHERE user_id = NEW.user_id
        AND collection = NEW.collection
        AND record_id = NEW.record_id
        AND deleted = 1
        AND last_mutation_id = NEW.mutation_id
    );

  UPDATE sync_mutations
  SET
    result_collection = NEW.collection,
    result_record_id = NEW.record_id,
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
    result_deleted = 1,
    result_payload = NULL,
    result_updated_at = (
      SELECT updated_at FROM sync_records
      WHERE user_id = NEW.user_id
        AND collection = NEW.collection
        AND record_id = NEW.record_id
    )
  WHERE user_id = NEW.user_id
    AND collection = NEW.collection
    AND record_id = NEW.record_id
    AND EXISTS (
      SELECT 1 FROM sync_records
      WHERE user_id = NEW.user_id
        AND collection = NEW.collection
        AND record_id = NEW.record_id
        AND deleted = 1
        AND last_mutation_id = NEW.mutation_id
    );

END;
