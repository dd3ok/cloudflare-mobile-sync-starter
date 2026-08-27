# ADR 0012: Recover account deletion after response loss

Status: accepted, 2026-08-13

## Context

Deleting the user invalidates the session before the client can safely know it
received the final response. A lost response or process death could therefore
leave stale local ownership metadata with no authenticated way to retry. The
old empty `204` also hid provider-revocation failures even though server data
was deleted successfully.

## Decision

The client creates a UUID-v4 operation ID and durably journals it with the
expected subject before `DELETE /v1/account`. The Worker binds both headers to
the authenticated subject. It stores a PII-free outcome and deletes the user in
one D1 batch. The outcome reports server deletion plus provider IDs whose
revocation is `confirmed` or `unconfirmed`; it never contains tokens, provider
subjects, email, or the account subject.

Only SHA-256 hashes of the random operation ID and expected subject are indexed.
Receipts expire after seven days. An unauthenticated, auth-rate-limited
`POST /v1/account-deletions/status` requires both original capability values
and returns `404` for any mismatch.

The Worker Cron Trigger prunes expired receipts every minute. Request-time
pruning remains defense in depth, not the retention mechanism.

The consumer reconciles the journal at startup. It detaches metadata only for
the journaled subject, preserves a different active account, and clears local
authentication only when it still belongs to the deleted subject or no subject
can be restored.

## Consequences

- Provider outage never blocks server-side deletion, but the UI can direct the
  user to remove an unconfirmed Google connection manually.
- Response loss and process death are idempotently recoverable for seven days.
- The random operation ID is a short-lived capability and must not be logged.
- An operator must treat deletion receipts as security metadata and include
  their expiry in retention and restore procedures.
