# Maintainer handoff

This repository is the product-neutral Platform Source for isolated mobile-app
deployments. Read `AGENTS.md`, `README.md`, `docs/ARCHITECTURE.md`, ADR 0013, and
ADR 0014, ADR 0017, and ADR 0018 before changing authentication, deployment, or request
portal behavior.

## Active invariants

Current dependency maintenance (2026-11-12): CI pins pnpm/action-setup 6.1.1
and actions/setup-node 7.1.0 by full release SHA, retaining pnpm 11.9.0 and
Node 24 with root @types/node 24.19.2. The root compiler is TypeScript 7.0.2; both Expo workspaces pin
TypeScript 6.0.3, as required by SDK 57 dependency validation. CI checks
Expo dependency compatibility before the full workspace gate. Worker development types are 5.20261110.1; runtime, compatibility
date, bindings, and migrations are unchanged. The reference app and Expo
client development environment use SDK 57.0.32 and React Native 0.86.3,
with their SDK 57 companion packages aligned. AsyncStorage remains 2.2.0
(SDK 57 recommendation); PR #10 is draft until separate native upgrade/data
preservation verification. The Better Auth Expo adapter remains 1.6.23. Product vendor archives,
installed apps, and deployment source pins are not updated by these PRs;
native build, sign-in, and device restore verification remain separate gates.

2026-11-11 local client security candidate: api-contract pins Zod 4.6.7;
expo-client pins Better Auth/core 1.7.7 while retaining Expo adapter 1.6.23
and its synchronous storage contract. Fetch 1.3.1 resolves to 1.3.2 to align
the plugin/client types. Package runtime source is unchanged. `pnpm check`
passed, including 40 Expo-client tests, 50 Worker tests and example web export.
All three archives were rebuilt for byeolsataro; exact hashes and local inputs
are in that product's `vendor/cloudflare-mobile-sync/security-update-20261111.json`.
The subsequent local Worker candidate pins Better Auth/auth CLI 1.7.7,
Hono 4.13.11, and Zod 4.6.7. Vitest 4.1.12, Vite 8.1.6, and source-map-js
1.2.2 remove the remaining Worker-path tool findings. `pnpm check` passes
with 51 Worker tests, including a fixed legacy-format signed cookie reading
existing records through real D1 authentication, cross-account/forged-cookie
denial, and unchanged stored account/record/mutation data. Normal session
expiry renewal remains allowed. Worker source, API and both migration sets
are unchanged from the deployed source. No remote deployment occurred.
The required whole-workspace gate also updates the reference app's SDK 57
patch/build dependencies and Worker test-tool dependencies. The expired
image-size exemptions are removed; the full audit has zero findings and the
peer check is clean. Wrangler remains 4.124.0 and the Workers test pool is
0.23.0; migration to its renamed plugin is separate from this security patch.
Product client archives and installed apps were not rebuilt or replaced.
Local checks do not establish GitHub-verified source/CI, remote deployment,
real Google sign-in/device restore, or human release approval.

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
