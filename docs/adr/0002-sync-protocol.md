# ADR 0002: Small compare-and-set sync protocol

- Status: accepted
- Date: 2026-07-20

## Decision

Use separate bounded push and pull endpoints over HTTPS.

- Record identity is `(authenticated user, collection, recordId)`.
- A create uses `baseRevision: 0`. An update or delete must provide the exact
  current revision.
- A stale base revision returns a per-mutation conflict with the current server
  record. It never overwrites silently.
- Every accepted mutation increments the record revision and receives a global,
  monotonic D1 change cursor.
- `(user_id, mutation_id)` is unique. Replaying a mutation returns its original
  accepted/conflict result and creates no duplicate change.
- Deletes create tombstones. The retention portion of this decision is
  superseded by ADR 0010: keep the latest tombstone and mutation identities, but
  compact superseded payload-bearing history for a deleted logical record.
- A push batch returns an ordered result per mutation. One conflict does not block
  independent mutations in the same HTTP request.

Initial limits are intentionally conservative:

| Item | Limit |
| --- | ---: |
| Request body | 256 KiB |
| Mutations per push | 25 |
| Pull page | default 50, maximum 100 |
| JSON payload | 64 KiB after serialization |
| JSON nesting | 20 levels |
| Collection name | 64 characters |
| Record ID | 128 characters |
| Mutation ID | 128 characters |

## Rationale

Compare-and-set is a conservative, deterministic record-level rule. It prevents
quiet data loss while leaving domain-specific conflict resolution in the host
application. It is simpler and more honest than pretending to merge opaque JSON.

D1 has no interactive transactions. A guarded record write plus database triggers
records the accepted mutation and monotonic change atomically without a
read-then-write race.

## Rejected alternatives

- Last-write-wins: simple, but can silently erase a newer offline edit.
- Field-level merge or CRDT: payloads are opaque, and no current requirement
  justifies the protocol and client complexity.
- Combined bidirectional transaction: complicates retry and partial conflict
  handling without improving the first vertical slice.
- Latest-tombstone pruning: unsafe until a reset/snapshot protocol exists.
