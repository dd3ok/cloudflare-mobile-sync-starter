# ADR 0003: Deletion and data minimization

- Status: accepted
- Date: 2026-07-20

The provider-outage behavior in this ADR is superseded by ADR 0006. Individual
sync-record deletion retention is superseded by ADR 0010.

## Decision

Remote account deletion requires a fresh authenticated session. The Worker first
attempts provider-specific grant removal, then atomically deletes sync records,
change history, mutation receipts, sessions, accounts, and the Better Auth user.

If a provider is temporarily unavailable, deletion returns a retryable error and
leaves the D1 account intact. The project does not add a queue or encrypted
deletion outbox in v1. With multiple providers, an external revocation that
already succeeded cannot be rolled back; retries must rely on each provider's
documented already-unlinked behavior.

Deleting the remote account disables sync but does not automatically erase the
host application's local database. Local deletion is a distinct, explicit
host-app action.

The starter syncs only collections explicitly allowed by deployment
configuration. The example uses an ordinary `notes` collection. No host-specific
sensitive fields are inferred or uploaded automatically.

## Rationale

- Provider tokens are needed to revoke Google and Naver grants; Kakao requires an
  unlink operation as part of service withdrawal. Deleting those tokens first can
  make a complete unlink impossible.
- A synchronous retry is simpler than introducing Queues, Cron Triggers, or a
  token-bearing outbox before operational need is demonstrated.
- Local-first data belongs to the host application and remains useful offline
  even when remote sync is removed.

## Consequences

- Provider outages can temporarily delay remote account deletion.
- Host apps must clearly distinguish "delete remote account" from "erase data on
  this device."
- Provider-console unlink webhooks and production policy checks remain
  credentialed integration work.
