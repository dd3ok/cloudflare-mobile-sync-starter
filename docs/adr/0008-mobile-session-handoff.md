# ADR 0008: Keep the maintained Expo session handoff with reverse-domain schemes

- Status: superseded by ADR 0009
- Date: 2026-07-23

## Context

Better Auth Expo 1.6.23 appends the response `Set-Cookie` value to a trusted
non-HTTP callback URL and stores it in Expo SecureStore. Its server plugin
deliberately skips this bridge for HTTP(S) redirects. Therefore, changing a
callback to an iOS Universal Link or Android App Link alone opens the app without
transferring the authenticated session.

RFC 8252 prefers claimed HTTPS callbacks and requires reverse-domain notation
when a private-use scheme is used. A complete claimed-HTTPS design would need a
maintained one-time session exchange. Building that exchange here would create a
new bearer-token/authentication protocol, contrary to this repository's rule not
to implement authentication primitives itself.

## Decision

Continue using the pinned, maintained Better Auth Expo bridge. Worker and Expo
client configurations require reverse-domain custom schemes.

Do not claim that reverse-domain schemes are equivalent to claimed HTTPS links.
Do not implement a custom handoff code, verifier, token endpoint, or cookie
rewriter in this starter.

## Consequences

- New examples and documentation use a reverse-domain scheme.
- Host-app build variants use schemes derived from their native application
  identifiers and require new native builds after a scheme change.
- A future migration requires maintained library support or a separately
  reviewed authentication design plus associated-domain files and native build
  identifiers; it is not a configuration-only change.

ADR 0009 records that later review and replaces this decision with an
audience- and S256-verifier-bound one-time HTTPS exchange.
