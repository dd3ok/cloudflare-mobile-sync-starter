# Operations

Reviewed: 2026-08-26

## Local verification

```bash
pnpm install
pnpm --filter @cloudflare-mobile-sync/worker migrate:local
pnpm --filter @cloudflare-mobile-sync/worker migrate:requests:local
pnpm --filter @cloudflare-mobile-sync/worker dev
pnpm check
git diff --check
```

Local Worker tests apply every migration to a disposable D1 database. The web
example validates layout and portable behavior only; Credential Manager requires
an Android development build and real Google clients.

## Release order

1. Merge and tag reviewed Platform Source.
2. In the private deployment repo, pin the full source commit, tree, toolchain,
   and every migration hash.
3. Validate the environment's Worker/D1/domain/application ID/Web client ID and
   required Better Auth secret names without printing values.
4. Apply forward-only D1 migrations.
5. Deploy the exact pinned Worker artifact.
6. Verify `/health`, negative native-auth cases, and no unexpected logs.
7. Build the consumer from the matching client packages.
8. Run the environment-crossing and production-signed physical-device gate.

Worker rollback does not roll back D1. Before reverting code, confirm that the
older Worker understands every already-applied migration. Never edit, delete, or
reuse an applied migration number.

## Key rotation

`BETTER_AUTH_SECRET` is the active key and `BETTER_AUTH_SECRETS` is the versioned
keyring. Add the new version first, deploy, verify existing sessions, then retire
the old version after its maximum session lifetime and owner-approved grace
period. Do not rotate the Google Web client ID as if it were a secret; changing
it is an audience cutover and requires coordinated Worker, Google, and signed-app
verification.

## Account deletion

The server deletes service data even when Google disconnect cannot be confirmed.
The native client may request Google revoke first, but that best-effort call must
not block D1 deletion. Keep deletion receipts free of email, provider subject,
token, and raw operation ID. If D1 is restored through Time Travel, reconcile
completed deletions before reopening traffic.

## Optional request portal

Apply APP_DB migration `0008_request_purge_ledger.sql` before applying
`request-migrations/0001_request_cases.sql` or enabling the portal. Record both
migration hashes and the exact `REQUEST_DB_GENERATION` in the private deployment
lock.

The scheduled handler writes the append-only APP_DB purge ledger before
removing terminal request details. Every portal route reapplies that ledger, so
a REQUEST_DB Time Travel restore stays in maintenance until restored details
are deleted and verified absent. Rehearse this with synthetic cases in an
isolated restored D1. Never update or delete ledger rows.

The same scheduled pass expires text-bearing pending cases at the configured
immutable-age boundary as `rejected/expired`. Repeating the pass is idempotent,
and an operator resolution that wins first is not overwritten. Expired cases
reuse the seven-day terminal purge. Monitor the oldest pending age so the
configured limit remains a safety bound rather than a normal response target.

Web account deletion remains a separate release flag. Keep it false until the
host deployment has also proven its existing app-account deletion recovery
ledger across APP_DB restore. The request-detail ledger does not replace that
account-generation ledger.

## Observability

Log request IDs, status, route class, and aggregate timing only. Never log
authorization headers, cookies, Google tokens, nonce plaintext, request bodies,
profiles, sync payloads, account IDs, or deletion capabilities. Verify the
actual Cloudflare log-retention setting in the dashboard before production.

## Incident stops

Stop traffic or release promotion when any of these occur:

- dev credentials are accepted in production or vice versa;
- nonce replay, expiry, application ID, or strict-body tests fail;
- provider token columns become non-null;
- deployed source/migration identity cannot be proven;
- custom domain and `BETTER_AUTH_URL` disagree;
- deletion or restore reconciliation cannot be demonstrated.
- the portal custom origin, Access assertion, Turnstile hostname, notice or
  evidence policy version, request DB generation, or either migration set cannot
  be proven.
