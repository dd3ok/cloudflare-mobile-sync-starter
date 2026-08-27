# Maintainer handoff

This repository is the product-neutral Platform Source for isolated mobile-app
deployments. Read `AGENTS.md`, `README.md`, `docs/ARCHITECTURE.md`, ADR 0013, and
ADR 0014, ADR 0017, and ADR 0018 before changing authentication, deployment, or request
portal behavior.

## Active invariants

- Android Google authentication is Credential Manager -> server-issued one-time
  nonce -> Google ID token -> Better Auth direct sign-in -> D1 session.
- Direct sign-in first creates an in-memory prepared session. A native host must
  commit it only inside its still-current serialized account operation, or
  abort it so only that attempt's server session is revoked. Do not expose the
  prepared token or cookie to product code.
- Only `{ token, nonce }` is accepted. Provider access/refresh tokens,
  caller-provided profiles, browser Google OAuth, callback routes, and explicit
  account linking are denied.
- Google Web client ID and Android application ID are public per-deployment
  metadata. No Google client secret is used.
- The Worker derives the user from the Better Auth session. Application data is
  always scoped to that user at the route and SQL boundary.
- Product/environment configuration lives in a private deployment repository,
  which pins a full source commit, tree, toolchain, and append-only migration
  hashes. Do not restore product Wrangler files here.
- Published migration files are immutable. `0004_mobile_auth_handoff.sql` is
  historical; do not edit or renumber it. The active nonce ledger begins at
  `0007_native_google_auth_attempt.sql`.
- Provider token storage is deliberately absent. Account deletion must not call
  server-side Google revoke with a nonexistent access token.
- Native hosts must use `revokeExpoSession`: revoke the exact authoritative
  Better Auth session before atomically comparing and clearing the Expo
  SecureStore cookie. Do not call `authClient.signOut` directly for host logout,
  and serialize sign-in/logout transitions so a replacement session cannot
  race local cleanup. The owned Expo adapter disables its persistent session
  cache and serializes complete response-application hooks; do not remove that
  stale-response fence or introduce a second account-bearing commit point.
- Do not deploy, mutate Cloudflare/D1/Google resources, publish packages, or
  change repository visibility without explicit owner authorization.
- The optional request portal is fail-closed by default. It uses `REQUEST_DB`,
  one-shot Google proof, Turnstile, Access JWT verification, and an append-only
  APP_DB request-purge ledger. Do not collapse the two databases, expose receipt
  secrets in URLs or logs, or let an operator manually complete an automated
  deletion case.

## Release gate

The pinned `react-native-nitro-google-signin` 2.0.0 adapter is conditional until
an Expo SDK 57 production-signed Android build verifies returning account, new
account picker, explicit button fallback, cancellation, nonce mismatch, expiry,
replay rejection, session restore, logout, and account deletion. Keep the
adapter seam so the native library can be replaced without changing Worker or
portable client contracts.

Run `pnpm check` and `git diff --check` for every change. Report all physical
device, signing, provider-console, DNS, D1, and deployment steps as unverified
until direct evidence exists.

Portal release evidence additionally includes the exact custom origin,
workers.dev/preview closure, Google JavaScript origin, Turnstile hostname,
Access audience and exact operator, both D1 migration sets and generations,
request-detail restore rehearsal, account-deletion restore rehearsal, retention
policy including the pending-age bound, and reject-only email routing. Keep both
portal feature flags false until their applicable evidence exists.
