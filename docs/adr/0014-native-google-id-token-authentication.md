# ADR 0014: Use native Google ID-token authentication

- Status: accepted; supersedes ADR 0008 and ADR 0009
- Date: 2026-08-19

## Context

The first Android product has no production users and can adopt a clean baseline.
The former browser OAuth flow moved a Better Auth session from a provider
callback into a private app scheme through a custom PKCE-bound handoff. Although
the handoff was bounded and one-time, it added a second bearer-transfer protocol,
callback configuration, provider secrets, temporary cookie storage, and several
failure modes that Android Credential Manager does not require.

Expo's current Google authentication guide identifies
`react-native-nitro-google-signin` as the Credential Manager option. Better Auth
1.6.23 supports direct social sign-in with a Google ID token and verifies its
signature, issuer, audience, expiry, maximum age, and optional nonce before
creating its D1 user, provider account, and session.

## Decision

1. Android obtains a Google ID token through Credential Manager. The token
   audience is one Web OAuth client ID from the same Google Cloud project as the
   package/SHA-1-bound Android client.
2. Before opening the account picker, the client creates a five-minute
   `/v1/native-auth/google/attempts` record. D1 stores a SHA-256 nonce digest,
   application ID, expiry, and consumption state; it never stores the nonce
   plaintext.
3. The client passes only `{ token, nonce }` and the attempt ID to Better Auth's
   direct `/v1/auth/sign-in/social` route. The Worker validates an exact strict
   body and atomically consumes the attempt before Better Auth handles it.
4. Access tokens, refresh tokens, caller-supplied profiles, browser callback
   fields, Google browser OAuth, and explicit account-linking routes are denied.
5. `GOOGLE_WEB_CLIENT_ID` and `NATIVE_APPLICATION_ID` are public deployment
   metadata. There is no Google client secret in the native-only baseline.
6. Provider tokens are not stored in D1. Account deletion always deletes the
   service account and sync data; Google disconnect is a best-effort native
   client action and is reported as unconfirmed when the server cannot prove it.
7. The shared Expo package owns the server/session adapter interface. A host app
   supplies a narrow Credential Manager provider, keeping native-library types
   out of the portable API and sync modules.
8. Product Wrangler files and external resource identities belong in the private
   deployment repository. This public source repository retains only a
   product-neutral reference configuration.

## Migration and compatibility

There are no production users to migrate. Browser OAuth and the handoff runtime
are removed rather than kept behind a compatibility flag. The historical
`0004_mobile_auth_handoff.sql` migration is not edited or renumbered because
published D1 migration history is append-only. New deployments also apply
`0007_native_google_auth_attempt.sql`; an unused old table may be removed later
with a forward-only migration after every existing D1 instance is inventoried.

ADR 0008 and ADR 0009 remain only as decision and migration history. They are
not active implementation guidance.

## Consequences

- Android no longer needs a Google redirect URI, Worker callback URL, custom
  callback handler, `expo-web-browser`, or Google client secret.
- Replay defense is explicit and testable independently of Better Auth's JWT
  checks.
- Google Web and Android clients must be separated by environment. Production
  still requires the Play App Signing SHA-1 and a production-signed physical
  device test.
- `react-native-nitro-google-signin` 2.0.0 is pinned behind the adapter because
  it is new. A small standalone Expo Module may replace it without changing the
  server or app-facing authentication interface.
- Kakao, Naver, iOS, offline Google access, Google API scopes, refresh tokens,
  and automatic account linking are outside this baseline and must be added as
  separate reviewed capabilities.

## Sources

- [Expo Google authentication](https://docs.expo.dev/guides/google-authentication/)
- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)
- [Android Credential Manager Sign in with Google](https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation)
- [Google server-side ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Better Auth Expo integration](https://www.better-auth.com/docs/integrations/expo)
- [Better Auth 1.6.23 direct social sign-in source](https://github.com/better-auth/better-auth/blob/v1.6.23/packages/better-auth/src/api/routes/sign-in.ts)
