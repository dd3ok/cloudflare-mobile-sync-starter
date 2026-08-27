# Cloudflare Mobile Sync

English | [한국어](./README.ko.md)

A small, self-hosted authentication and incremental-sync platform for mobile
apps. Each host application deploys an isolated Cloudflare Worker and D1
database. This repository is a reusable starter source tree, not a shared hosted service.

## Baseline

- Android Credential Manager obtains a Google ID token.
- The Worker issues and atomically consumes a five-minute, one-time nonce.
- Better Auth 1.6.23 verifies the Google token and creates the D1 session.
- The app stores only the Better Auth session cookie in Expo SecureStore.
- Google access, refresh, and ID tokens are not persisted in D1.
- Browser OAuth, Worker callbacks, private-scheme token handoff, Google client
  secrets, Kakao, and Naver are not part of the active baseline.
- Sync remains local-first, user-scoped, bounded, and explicit.

`react-native-nitro-google-signin` 2.0.0 is pinned behind a narrow adapter. It
must pass a production-signed physical-device gate before any product release.

## Workspace

```text
apps/worker               Cloudflare Worker and D1 migrations
packages/api-contract     portable runtime schemas and types
packages/client-core      platform-neutral sync orchestration
packages/expo-client      Expo session and native Google adapter boundary
examples/expo-app         Android Credential Manager reference consumer
docs                      architecture, security, operations, and ADRs
```

Product-specific Worker names, D1 IDs, domains, Google Cloud projects, Android
application IDs, and release evidence do not belong here. Keep them in a private
deployment repository that pins this source by exact commit and migration hash.

## Local checks

Requirements: Node.js 22.13–24 and pnpm 11.9.0.

```bash
pnpm install
pnpm --filter @cloudflare-mobile-sync/worker migrate:local
pnpm --filter @cloudflare-mobile-sync/worker dev
pnpm check
```

Copy `apps/worker/.dev.vars.example` to the ignored `.dev.vars` file and replace
the Better Auth secret placeholders. The committed Wrangler file is a
non-production example. Do not run a remote migration or deploy from it.

Native Google sign-in needs an Expo development build; Expo Go and the web
preview cannot verify Credential Manager. Before a device test, create a Web
client and a package/SHA-1-bound Android client in the same Google Cloud project,
then set the deployment's public `GOOGLE_WEB_CLIENT_ID` and
`NATIVE_APPLICATION_ID` vars.

See [architecture](./docs/ARCHITECTURE.md), [configuration](./docs/CONFIGURATION.md),
[API](./docs/API.md), [provider setup](./docs/PROVIDERS.md),
[security](./docs/SECURITY.md), [operations](./docs/OPERATIONS.md), and
[ADR 0014](./docs/adr/0014-native-google-id-token-authentication.md).

The Worker also contains an optional, disabled-by-default privacy-request
portal with a separate D1, secret receipts, Turnstile, Access-protected review,
bounded pending-text expiry, and restore-safe detail purge. See
[ADR 0017](./docs/adr/0017-optional-request-portal.md). Product configuration and
release evidence still belong only in the private deployment repository.

## Deliberate limits

This is not Firebase, a CRDT engine, a multi-tenant SaaS, or a realtime
subscription service. It currently supports Android Google sign-in only. iOS,
additional providers, Google API scopes, offline access, refresh tokens, and
automatic account linking require separate reviewed capabilities.

## License

The source is available under the [MIT License](./LICENSE). Workspace packages
remain `private: true` until a separate public-package release is approved.
