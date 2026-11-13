# Dependency PR follow-up — 2026-11-14

Base: `bbe6285771fae74ac98c524b81317e16c6b7de13`.
This is a local source candidate; deployed product source pins and installed apps are separate.

## Changes

- [PR #36](https://github.com/dd3ok/cloudflare-mobile-sync-starter/pull/36): adopt `jose` 6.2.17. The existing portal JWT verification and negative authentication tests remain in place.
- [PR #38](https://github.com/dd3ok/cloudflare-mobile-sync-starter/pull/38): adopt `react-native-nitro-modules` 0.37.2 in the reference app. Production-signed native sign-in still requires the existing physical-device gate.
- [PR #39](https://github.com/dd3ok/cloudflare-mobile-sync-starter/pull/39): adopt Vitest 5.1.0 together with `@cloudflare/vitest-plugin` 1.8.1. The old pool 0.23.0 declares Vitest `^4.1.0` peers; its CI run failed to start five Worker test files with `Unexpected identifier 'file'`. The new plugin declares `^4.1.0 || ^5.0.0`. Dependency name, config import, D1 migration type and test TypeScript types follow the [official migration guide](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/). Existing tests and assertions remain intact.
- [PR #37](https://github.com/dd3ok/cloudflare-mobile-sync-starter/pull/37): retain React and React DOM 19.3.0. The [failed compatibility job](https://github.com/dd3ok/cloudflare-mobile-sync-starter/actions/runs/43378994052/job/131732104538) explicitly requires React DOM 19.3.0 for the pinned Expo SDK. Revisit as a coordinated Expo-compatible update; do not exclude React DOM from the compatibility check.

Worker runtime code, API contracts, migration files, compatibility date and bindings are unchanged. The direct deploy/build Wrangler dependency remains 4.124.0; the new test plugin has its own pinned transitive runtime. No CI gates, audit exceptions or dependency-update monitoring are disabled.

## Reproducible installation

The first resolution used cached metadata that omitted `workerd` 1.20261110.1's optional platform packages. Its install step found an older hoisted Windows binary and correctly rejected the version mismatch. A fresh metadata cache produced the complete platform entries. The committed lockfile pins them, and ordinary `pnpm install --frozen-lockfile` then succeeded. No binary version check or install-script policy was bypassed.

## Verification commands

```text
pnpm install --frozen-lockfile
pnpm --filter @cloudflare-mobile-sync/expo-app exec expo install --check
pnpm --filter @cloudflare-mobile-sync/expo-client exec expo install --check
pnpm check
pnpm security:audit
git diff --check
```

## Results

Verified locally on Windows with Node 24.18.0 and pnpm 11.9.0:

- Frozen-lockfile installation and both Expo compatibility checks passed.
- `pnpm check` passed: TypeScript, Biome, 131 tests (16 preflight, 7 API contract, 12 client core, 56 Worker and 40 Expo client), package builds, Worker deployment dry run, Expo web export and the secret-pattern scan.
- The Expo client initially resolved an obsolete generated Vitest 4.1.12 shim left in its local `node_modules/.bin`. Only those three stale shim files were removed, followed by another frozen-lockfile install. Its version check reported Vitest 5.1.0 and all 40 tests passed again on that version. The lockfile contains no Vitest 4.1.12 entry.
- `pnpm security:audit` reported no known vulnerabilities; `git diff --check` passed.
- Worker runtime source and both migration directories match the base. Existing test assertions are unchanged.

Remote PR branches, GitHub CI for this combined candidate, production deployment and physical-device testing are not changed by local verification.
