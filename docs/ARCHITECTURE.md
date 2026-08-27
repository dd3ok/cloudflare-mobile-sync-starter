# Architecture

Reviewed: 2026-08-26

## System boundary

```text
Host Android app
  local database
  Credential Manager adapter
  @cloudflare-mobile-sync/expo-client
             |
             | HTTPS + Better Auth session cookie
             v
Cloudflare Worker
  strict native-auth guard
  Better Auth 1.6.23
  user-scoped sync repository
             |
             v
isolated D1 database
```

One deployment instance serves one host application and one environment. Dev
and production do not share a Worker, D1 database, rate-limit namespace, Google
Cloud project, Web client, Android client, application ID, session secret, or
data namespace.

## Authentication flow

1. The Expo adapter asks the Worker for a native Google attempt.
2. The Worker creates 32 random nonce bytes, stores only its digest in D1, and
   returns the nonce, attempt ID, and configured Web client ID.
3. The host adapter configures Android Credential Manager with that Web client
   ID and nonce, then obtains a Google ID token.
4. The Worker accepts only the exact Google direct-ID-token body and atomically
   consumes the attempt.
5. Better Auth verifies the token and Google `sub`, then creates or finds the
   `(providerId = google, accountId = sub)` account and a D1 session. The Expo
   adapter keeps its response cookie and token in an in-memory prepared-session
   handle instead of exposing them or installing them immediately.
6. The host commits that handle only while its serialized account operation and
   the captured shared-session epoch are unchanged. The Expo adapter then stores
   the service session cookie in SecureStore and signals a session refresh.

The official Expo client adapter initially represents the application scheme in
its private `expo-origin` header. Before network dispatch, `expo-client`
promotes that value to the standard `Origin` header and removes the private
header. The platform-neutral Worker therefore receives the same standard
contract from Expo, bare Android, Swift, Flutter, or other future clients, and
Better Auth applies its exact `trustedOrigins` CSRF check without an Expo server
plugin or Expo-only endpoint.

The Worker does not implement JWT verification, OAuth code exchange, or cookie
signing. Better Auth owns those primitives. The small nonce ledger adds replay
state that Better Auth 1.6.23 does not persist.

This statement applies to native session authentication. When the optional
request portal is enabled, its Google and Cloudflare Access adapters verify
one-shot identity assertions with remote JWKS. They create no portal session,
cannot create an application account, and do not change the native flow.

Native logout first performs an authoritative session read and revokes that
exact D1-backed Better Auth session. Only after revocation succeeds does the
Expo adapter atomically compare and clear its SecureStore cookie; a replacement
cookie is preserved. This ordering preserves a retry credential if server
revocation fails and prevents a local-only logout from leaving a live server
session.

## Module boundaries

- `api-contract` owns portable runtime schemas and limits.
- `client-core` owns platform-neutral transport, retry, and sync state.
- `expo-client` owns prepared-session commit/abort, SecureStore session
  integration, and a narrow `NativeGoogleCredentialProvider` interface,
  including translation from the official Expo adapter's private origin header
  to the standard HTTP contract.
- The host app owns the selected native Credential Manager library and its Expo
  config plugin. Native-library types do not cross the adapter seam.
- The Worker owns request validation, authorization, D1 persistence, and
  deletion receipts.
- The optional `RequestCases` module owns request opening, secret-receipt view,
  one bounded pending review, immutable-age expiry, terminal resolution, and
  detail purge. It writes request content only to `REQUEST_DB`; account deletion
  remains an in-process call to the existing APP_DB module.
- The private deployment repository owns resource identities, public domains,
  environment mapping, exact source pins, secrets requirements, and evidence.

This keeps the portable packages usable from future native Android, Swift,
Flutter, or bare React Native adapters without importing Expo or Cloudflare
runtime APIs.

## Data model

Better Auth owns `user`, `account`, `session`, and its support tables. The
platform owns `native_google_auth_attempt`, sync records/change receipts,
retained tombstone receipts, and account deletion receipts.

An enabled request portal adds `request_case` and `request_evidence` to its
separate `REQUEST_DB`. APP_DB contains only the append-only, non-identifying
`request_purge_ledger` needed to re-delete request details after a REQUEST_DB
restore. Every portal route verifies that reconciliation before serving data.

Provider token columns remain nullable and must be null after native Google
sign-in. Sync identity is `(session user, collection, recordId)`. Provider email
is mutable profile data; Google `sub` is the provider account identity.

## Historical compatibility

The PKCE browser handoff is removed from runtime and active documentation.
Migration `0004_mobile_auth_handoff.sql` and ADRs 0008/0009 remain immutable
superseded decision history. Identifier-only privacy redactions do not change
their decision semantics. ADR 0014 is authoritative; the
[ADR status index](./adr/README.md) distinguishes active decisions from
superseded context.
