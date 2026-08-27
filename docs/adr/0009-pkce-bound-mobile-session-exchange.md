# ADR 0009: Exchange mobile sessions over HTTPS with a one-time PKCE-bound code

- Status: accepted; supersedes ADR 0008
- Reviewed: 2026-08-13

## Context

Better Auth Expo 1.6.23 bridges a newly created session by placing its signed
cookie in the query of a trusted non-HTTP callback. Android does not give an app
exclusive ownership of a private custom scheme, so the callback was carrying a
bearer credential across an interceptable boundary. Reverse-domain naming
reduces collisions but does not establish app ownership.

Expo SDK 57 provides the browser, linking, random-byte, and SHA-256 APIs needed
for an app-held verifier. Better Auth supports starting social sign-in with
`disableRedirect`, while its existing provider state, nonce, and server-side
code exchange remain authoritative. The missing boundary is only the transfer
of the resulting Better Auth session to the initiating app.

## Decision

Add a narrow mobile handoff module between the app-wide authentication
coordinator, the Expo adapter, and the Worker:

1. The app generates a 32-byte random verifier and its S256 challenge.
2. `POST /v1/mobile-auth/handoffs` accepts only an exact mobile audience from
   `TRUSTED_ORIGINS`. It stores a prepare row for at most ten minutes, matching
   the provider-flow state window, and is subject to the existing auth limiter
   and bounded body parser before JSON parsing.
3. The app starts Better Auth with a callback containing only the opaque
   handoff ID. The Better Auth Expo authorization proxy and provider protections
   remain in place.
4. On the provider callback, the Worker captures the Better Auth session before
   it crosses the private scheme, binds it to the handoff, stores only a hash of
   a random one-time code, and shortens the ready window to 60 seconds. It
   removes both `Set-Cookie` and the `cookie` query parameter from the redirect.
5. The app rejects any callback that contains a cookie. It validates the exact
   audience, callback host, handoff ID, and single code, then exchanges the code
   and verifier over HTTPS. Only after a successful exchange is the signed
   Better Auth cookie written to Expo SecureStore.
6. Exchange is audience-bound, verifier-bound, atomic single-use, and generic
   on failure. The ready session itself is shortened to 60 seconds and its
   original expiry is restored only in the successful exchange transaction.
   Cancellation and expiry cleanup revoke an unclaimed ready session but never
   a successfully exchanged one. A Worker Cron Trigger also prunes expired
   handoffs every minute, so cleanup does not depend on another authentication
   request arriving.
7. The app verifies that the exchange subject equals the subsequent Better Auth
   session subject. Its authentication-generation signal cancels a superseded
   browser/exchange operation and clears a locally stored result before it can
   be adopted.
8. Destructive account deletion additionally sends the UI's expected subject;
   the Worker rejects a missing or changed subject before deletion.
9. The Worker rebuilds every private-scheme callback from its scheme, host, and
   path. Success contains exactly `mobile_handoff` and the one-time `code`;
   bounded errors contain no provider parameters. Query extras, fragments, and
   userinfo are never forwarded. The Expo adapter independently requires the
   same exact query-key set and an empty fragment.

Legacy cookie-query callbacks now fail closed: the Worker removes the bearer,
revokes the just-created session, and returns `mobile_handoff_required`.

## D1 bearer-storage decision

The ready handoff temporarily retains the signed cookie until a successful
exchange or for at most its 60-second exchange window. A successful exchange
atomically clears both the cookie copy and one-time code hash; it retains only
the challenge and session identity so a locally aborted generation can still
revoke the now-unwanted server session. Reconstructing the cookie from the Better Auth session token would
couple this module to Better Auth's non-public cookie-signing implementation and
key-rotation details. Encrypting it with a new home-grown envelope would add
another cryptographic protocol. Both were rejected.

D1 already contains the authoritative raw session token in Better Auth's
session table. The handoff copy adds no longer-lived credential class: it is
erased on exchange and unreachable after expiry, its row is pruned, and session expiry or
revocation remains authoritative even if D1 Time Travel retains an older page.
A future maintained Better Auth server token/cookie issuance API should replace
the temporary copy.

## Deployment isolation

A host app's development, preview, and production environments have separate Worker
configurations, D1 bindings, rate-limit namespaces, exact app schemes,
collection namespaces, public origins, Google OAuth clients, and Worker
secrets. Pending environments keep schema-valid sentinels and are not
deployable. A maintainer production instance was independently provisioned on
2026-08-18 and was marked ready only after remote D1 migration and secret-name
preflight passed. Development and preview remained pending. Preflight fails
before secret inspection while deployment metadata lists any unresolved
external resource.

## Consequences

- Migration `0004_mobile_auth_handoff.sql` must be applied before enabling
  mobile login.
- Existing deployed cookie-query clients stop receiving a session and must use
  the new Expo adapter.
- A source build and all three consumer archives must move together.
- Real Cloudflare IDs, origins, Google web-client credentials, remote migration,
  deployment, and physical-device verification remain explicit release gates.
- Claimed HTTPS app links remain preferable when the maintained auth stack can
  complete the whole handoff through them, but they are not required to keep a
  bearer out of the current private-scheme callback.

## Sources

- [Expo SDK 57 WebBrowser](https://docs.expo.dev/versions/v57.0.0/sdk/webbrowser/)
- [Expo SDK 57 Linking](https://docs.expo.dev/versions/v57.0.0/sdk/linking/)
- [Expo SDK 57 Crypto](https://docs.expo.dev/versions/v57.0.0/sdk/crypto/)
- [Better Auth Expo integration](https://better-auth.com/docs/integrations/expo)
- [Better Auth basic usage (`disableRedirect`)](https://better-auth.com/docs/basic-usage)
- [OAuth 2.0 for native apps (RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252)
- [PKCE (RFC 7636)](https://www.rfc-editor.org/rfc/rfc7636)
- [Cloudflare D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Google OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
