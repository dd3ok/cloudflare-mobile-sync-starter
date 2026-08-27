# ADR 0010: Compact deleted sync data and support exact collection pulls

- Status: accepted
- Date: 2026-08-13

## Context

The original v1 protocol kept every accepted change and the complete result of
every mutation indefinitely. A tombstone hid a deleted record from clients, but
older `sync_changes` rows and mutation request/result payloads still retained
the deleted JSON. That is incompatible with a meaningful per-record deletion
for sensitive opt-in collections.

Consumers that need only one collection also had to walk the user-wide change
feed. A profile or preference availability check could therefore scan thousands
of unrelated saved-reading changes and mistake a bounded scan for a complete
collection result.

## Decision

Keep the public push/pull interface and CAS rule, but change durable receipt and
deletion behavior as follows:

1. After any mutation is finalized, set its submitted `payload` column to SQL
   `NULL`. The accepted/conflict result snapshot remains sufficient for normal
   idempotent replay while the record is active.
2. When a delete is accepted, retain the latest payload-free tombstone in
   `sync_records` and `sync_changes`, and remove every older change row for the
   same `(user, collection, recordId)`.
3. Keep every prior mutation ID and its accepted/conflict status reserved, but
   replace its record result with the latest tombstone. Replaying an ID remains
   side-effect free and reports `replayed: true`; it cannot recover deleted JSON.
4. Retain tombstones and compacted mutation identities indefinitely in v1.
   Cursor gaps remain valid. Do not introduce a TTL until the protocol also has
   an explicit stale-device reset or snapshot mechanism.
5. Add optional exact `collection` filtering to pull. Filtering happens in SQL
   using `(user_id, collection, cursor)`, before limit and pagination.

A filtered feed has its own cursor sequence. Start a newly tracked collection at
cursor `0`, persist the returned `nextCursor` for that exact collection, and do
not reuse a cursor from the unfiltered feed or another collection. `nextCursor`
is the last matching global cursor, so gaps caused by other users, other
collections, or compaction are expected.

If a single push batch puts and then deletes the same record, deletion
compaction occurs before the batch receipt query. Both accepted results can
therefore carry the final tombstone. Their statuses, mutation identities, and
at-most-once effect remain stable; the transient pre-delete payload does not.

## Rationale

This is the smallest interface-compatible design that meets both offline
deletion and storage minimization. An offline device starting at any older
cursor still receives the retained tombstone. Keeping the mutation identity and
status prevents an old retry from becoming a new write, while tombstone
replacement closes the replay path to deleted content.

The exact collection filter removes cross-collection scan limits without adding
new endpoints or a collection-specific cursor type. The composite index matches
the authenticated query shape.

Deletion work is proportional to the number of historical changes and mutation
receipts for that one logical record. Composite record indexes bound lookup
cost, and the intended profile/setting/one-reading-per-record model keeps the
affected set small. A future host that repeatedly mutates one hot record at very
high volume must measure delete and migration duration against D1's query limits
and design a versioned batched compaction before enabling that workload.

## Rejected alternatives

- Retain full history until a fixed TTL: this continues retaining deleted
  content during the window and still needs a reset protocol after expiry.
- Prune tombstones and introduce a feed epoch now: stronger bounded retention,
  but it expands every client and conflict path before measured need.
- Delete all prior mutation receipts: an old mutation ID could lose its durable
  replay identity and no longer have stable at-most-once behavior.
- Post-filter a user-wide page in the Worker: unrelated rows can consume the
  page limit and create false completion.
- Reuse one cursor across filtered streams: a cursor advanced by one collection
  can skip older changes in another collection.

## D1 recovery and export boundary

The live tables stop retaining the superseded payload after migration or an
accepted delete. Cloudflare D1 Time Travel is always enabled independently of
the application schema and can restore prior database state for up to 7 days on
Workers Free or 30 days on Workers Paid. Operator-created SQL/R2 exports are
separate copies and must have their own deletion and expiry controls. A restore
must replay deletion reconciliation before restored data can serve production.

## Sources reviewed

Reviewed 2026-08-13:

- [D1 Database binding and transactional batch behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 migrations and deferred foreign keys](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 limits, including Time Travel windows](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
