# ADR 0016: Normalize Expo origin at the client boundary

- Status: accepted
- Date: 2026-08-22

## Context

Better Auth requires a trusted `Origin` for cookie-authenticated state-changing
requests. Its Expo client adapter emits the application scheme as
`expo-origin`, while its matching server plugin copies that value to `Origin`
and also installs Expo-specific server behavior. Installing that plugin in the
Worker would violate this repository's platform-neutral HTTP boundary.

## Decision

- `packages/expo-client` promotes `expo-origin` to the standard `Origin` header
  immediately before network dispatch, then removes `expo-origin`.
- An existing standard `Origin` is never overwritten.
- The Worker and Better Auth configuration accept only the standard header and
  continue to validate it against exact deployment `TRUSTED_ORIGINS` entries.
- The Worker does not install `@better-auth/expo` or expose its authorization
  proxy. Other native adapters send the same standard header contract.

## Consequences

Expo-specific behavior stays inside the Expo package and the Worker remains
usable by future bare Android, Swift, Flutter, and React Native adapters. The
client translation needs unit coverage and a physical-device gate because the
native networking stack must preserve the explicit `Origin` header. This does
not make the app scheme an authenticator; the D1-backed session cookie remains
the credential and exact-origin checking remains CSRF defense.
