# ADR status index

This index identifies the current decision authority without rewriting published
decision records.

- ADR 0013 is authoritative for the public Platform Source/private deployment
  boundary.
- ADR 0014 is authoritative for Android Google authentication.
- ADR 0015 is authoritative for native current-session logout ordering.
- ADR 0016 is authoritative for the platform-neutral native origin contract.
- ADR 0017 is authoritative for the optional request portal, its separate D1,
  one-shot web identity proof, and restore-safe detail purge.
- ADR 0018 is authoritative for prepared native-session ownership and atomic
  shared-session commit.
- ADR 0004 is historical deployment context; its product deployment placement
  is superseded by ADR 0013 and its browser OAuth guidance is superseded by ADR
  0014.
- ADR 0008 and ADR 0009 are immutable, superseded authentication history. They
  are not implementation or operations guidance.

Real Worker, D1, DNS, provider-project, application, and product-collection
identifiers belong only in a private deployment repository.

On 2026-08-21, the current copies of historical ADRs received identifier-only
privacy redactions. Their decisions and status were preserved; original commits
remain reachable in Git history until a separately approved history migration.
