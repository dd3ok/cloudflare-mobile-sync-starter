# ADR 0001: Runtime and authentication baseline

- Status: accepted
- Date: 2026-07-20

## Decision

Use a small pnpm TypeScript workspace, a Hono Worker, Cloudflare D1, Better Auth
1.6.23 with its direct D1 binding, and `@better-auth/expo` 1.6.23 for the Expo SDK
57 adapter.

The Worker uses database-backed cookie sessions. The Expo package supplies the
cookie header from SecureStore to the portable HTTP client. OAuth tokens are
encrypted in D1. Same-email implicit linking is disabled; explicit linking is
allowed only from an authenticated session. The last login method cannot be
unlinked.

Google is the first provider. Kakao and Naver remain small server-only Generic
OAuth configurations. Provider identity is `(providerId, providerSubject)`.
Missing provider emails become internal `.invalid` placeholders.

## Rationale

- Better Auth now supports D1 directly, so another adapter and ORM would add
  indirection without improving this starter.
- Cookie sessions use the officially documented Better Auth Expo bridge and keep
  provider tokens off the device.
- Explicit linking and encrypted tokens fix insecure Better Auth defaults for this
  threat model.

## Rejected alternatives

- `better-auth-cloudflare`: useful community integration, but unnecessary for the
  required D1-only scope after first-party D1 support landed.
- Bearer plugin: creates a longer-lived bearer-token surface without a requirement.
- Native provider SDKs: would duplicate provider-specific behavior in the mobile
  package and weaken the platform-neutral boundary.
- Custom OAuth or cryptography: outside scope and unsafe.

## Consequences

- SDK 57 compatibility must be verified in a development build because Better
  Auth's current Expo guide is written for SDK 55.
- Real provider credentials, registered callbacks, and physical-device checks are
  still required before calling any provider production-ready.

