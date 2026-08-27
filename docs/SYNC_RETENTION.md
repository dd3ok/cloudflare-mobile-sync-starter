# Sync retention and deletion operations

Reviewed: 2026-08-13

This document describes source behavior after migration
`0005_sync_deletion_compaction.sql`. It does not claim that migration is active
in a remote deployment until the operator verifies the remote migration list and
post-migration checks.

## Live D1 retention states

| State | `sync_records` | `sync_changes` | `sync_mutations` |
| --- | --- | --- | --- |
| Active record | current payload | accepted change snapshots | mutation identity/status and result snapshot; submitted request payload is `NULL` |
| Deleted record | latest tombstone, payload `NULL` | latest tombstone only | identities/statuses remain; every result for that record is the latest tombstone and all payload columns are `NULL` |
| Deleted account | removed by `user` foreign-key cascade | removed | removed |

Tombstones and compacted mutation identities have no TTL in v1. They are the
minimum durable state needed for an arbitrarily stale device to observe a
deletion and for an arbitrarily late mutation retry to remain side-effect free.
Do not prune either table until a versioned feed epoch/reset protocol exists and
every supported client can discard an expired cursor and rebuild a snapshot.

## Migration 0005 preflight and verification

Apply and rehearse the migration against a disposable local D1 before any remote
operation. On the intended remote database, first verify the database name/ID,
current migration list, and that no migration is already recorded under an
unexpected filename. Do not edit or mark a migration applied manually.

Before migration, verify that this returns zero. Any persisted `pending` row is
an invariant failure and migration 0005 deliberately stops instead of discarding
its request payload:

```sql
SELECT COUNT(*) AS pending_mutations
FROM sync_mutations
WHERE status = 'pending';
```

Also record count-only estimates of superseded change rows and receipt rows for
deleted records. Migration 0005 performs this repair transactionally, not in
batches. If a representative disposable rehearsal approaches D1's query-time
limit, stop and write a new reviewed batched migration/cutover procedure; do not
partially run hand-written cleanup against production. The intended app model
uses separate records for separate readings and should keep each runtime delete
small, but that assumption must be rechecked before adopting a hot-record model.

After migration, these read-only checks should return zero:

```sql
SELECT COUNT(*) AS retained_deleted_change_payloads
FROM sync_changes AS change
JOIN sync_records AS record
  ON record.user_id = change.user_id
 AND record.collection = change.collection
 AND record.record_id = change.record_id
WHERE record.deleted = 1
  AND (change.payload IS NOT NULL OR change.cursor <> record.cursor);

SELECT COUNT(*) AS retained_finalized_request_payloads
FROM sync_mutations
WHERE status IN ('accepted', 'conflict')
  AND payload IS NOT NULL;

SELECT COUNT(*) AS retained_deleted_receipt_payloads
FROM sync_mutations AS mutation
JOIN sync_records AS record
  ON record.user_id = mutation.user_id
 AND record.collection = mutation.collection
 AND record.record_id = mutation.record_id
WHERE record.deleted = 1
  AND (
    mutation.result_payload IS NOT NULL
    OR mutation.result_deleted <> 1
    OR mutation.result_cursor <> record.cursor
  );
```

Use counts only in ordinary operations. Do not select payloads to prove that
they were erased. Run an authenticated disposable-data exercise covering put,
conflict, delete, pull from cursor zero, and replay of both the put and delete
mutation IDs. The pull and replays must expose only the tombstone.

## D1 Time Travel and exports

Deleting or compacting live rows does not immediately remove older state from
D1 Time Travel. Cloudflare documents that Time Travel is always on and retains
up to 7 days on Workers Free or 30 days on Workers Paid. The plan determines
this window; the application cannot configure a shorter one.

Do not create routine raw exports by default. If a consequential migration needs
an export, encrypt and access-restrict it, inventory its owner/location/purpose,
and assign a destruction timestamp no later than 30 days after successful
verification unless the legal owner has approved a different documented
obligation. Never commit or attach an export to a support case.

Before serving traffic from any Time Travel restore or SQL/R2 export:

1. keep the Worker unavailable;
2. reconcile every still-retained deletion receipt against the restored copy;
3. reapply exact scoped deletions and verify zero rows;
4. invalidate restored sessions; and
5. exercise the client cursor recovery plan against disposable state.

The current repository does not automate an external deletion-reconciliation
ledger or a sync feed epoch reset. A production restore therefore remains a stop
condition until the private deployment supplies and rehearses those controls.
See [operations](./OPERATIONS.md).

## Owner decisions still required for an operated service

Code cannot choose the Cloudflare plan or an external receipt/export system.
Before promising a specific deletion completion window, the legal owner must
record:

- Free (7-day) or Paid (30-day) D1 Time Travel exposure;
- the restricted deletion-receipt location, roles, and retention period;
- any export retention exception and its legal basis; and
- the reviewed restore approver and reconciliation tool.

These decisions do not block local code tests, but they block a production claim
that recovery copies are fully governed.

## Official sources

- [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
