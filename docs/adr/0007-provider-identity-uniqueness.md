# ADR 0007: Provider identities are globally unique per deployment

- Status: accepted
- Date: 2026-07-23

## Decision

D1 enforces a unique index on `(providerId, accountId)`. A provider identity can
belong to only one local Better Auth user in a self-hosted deployment.

The application still does not link accounts merely because providers return the
same email address. Explicit linking remains a fresh, authenticated provider flow.

## Rationale

An application-level lookup followed by insert is not sufficient under concurrent
OAuth callbacks. The database uniqueness constraint is the final authorization
invariant and fails closed if two callbacks try to claim the same identity.

## Consequences

- One concurrent callback can receive a transient error after the other wins;
  retrying resolves against the stored identity.
- Existing deployments must check for duplicates before applying migration 0003.
  The migration intentionally fails rather than choosing an owner automatically.
