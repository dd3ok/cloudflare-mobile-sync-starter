# ADR 0011: Compact sensitive history behind a retained lineage tombstone

Status: accepted, 2026-08-13

## Context

Some consumers represent a privacy erasure as a non-sensitive `put` marker so
offline devices can learn that an earlier profile must not be restored. The
delete-only compaction in migration 0005 cannot recognize such a marker and
therefore leaves older payload-bearing changes and receipt snapshots live.
Making every ordinary `put` trigger compaction would let arbitrary payloads or
collections invoke destructive history removal.

## Decision

`POST /v1/sync/retained-tombstone` is a separate authenticated operation. Each
allowed target is configured as the exact collection, record ID, subject-hash
namespace, payload schema, and payload version. The Worker also derives
`SHA-256(namespace + ":" + authenticated subject)` and requires it to equal the
marker's account-slot key.

The portable contract accepts only a strict lineage marker: canonical UTC
timestamp, bounded unique UUID-v4 ancestors, exact `{ "state": "deleted" }`
value, and null consent. Unknown fields or profile values are rejected.

The existing mutation trigger performs CAS and reserves the operation ID. Only
an accepted marker then causes one D1 batch to:

1. retain its latest non-sensitive record and change for offline propagation;
2. delete older changes for that exact authenticated logical record; and
3. replace all prior receipt snapshots for that record with the marker.

A conflict performs no compaction. Replays return the already committed marker
and cannot recover an earlier payload. A mutation ID previously used for a
different payload is rejected.

## Consequences

- The operation is narrow and opt-in; ordinary puts and other collections
  cannot erase history.
- The latest marker and mutation identities remain indefinitely under the v1
  cursor model.
- Live D1 rows are scrubbed, but Time Travel and external exports retain their
  independent recovery windows and restore reconciliation requirements.
- Adding a target requires a reviewed config and strict portable schema, not a
  caller-selected compaction flag.

