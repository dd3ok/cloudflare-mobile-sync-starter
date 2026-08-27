# ADR 0015: Revoke the native server session before local sign-out

- Status: accepted
- Date: 2026-08-21

## Context

Better Auth's Expo plugin clears its SecureStore cookie when a native sign-out
request begins. Better Auth 1.6.23's ordinary sign-out endpoint also catches a
database session-deletion error and still returns success. A lost response or a
database adapter failure can therefore leave no local retry credential while a
server session remains active.

The platform uses stateful D1 sessions with cookie caching disabled. The
authoritative server row must be revoked before the device discards its cookie.

## Decision

- Native hosts call the portable Better Auth `revokeSession` endpoint for the
  exact current session token before calling `signOut`.
- The current session is read authoritatively with cookie-cache bypass enabled.
- A failed authoritative read or revocation preserves the local cookie and is a
  retryable failed logout.
- A definitive authoritative `no session` result clears the stale local cookie
  without another revocation attempt. Transport errors and indeterminate server
  failures still preserve the cookie.
- Hosts serialize sign-in and logout transitions. The helper also rejects a
  logout when the local session cookie changes before or during revocation, so
  it never clears a replacement session.
- After confirmed server revocation, the Expo client atomically compares and
  clears the captured SecureStore cookie and cached session. It does not issue a
  second sign-out request. A replacement cookie is preserved and reported to
  the host as a changed session.
- The session token remains in memory only. It is never logged, returned to the
  host, placed in evidence, or persisted outside Better Auth's SecureStore and
  D1 session table.

## Consequences

Logout adds one authoritative session read and one revocation request before
local cleanup. This is acceptable for an explicit security-sensitive action.
Hosts must use the shared Expo helper rather than calling `authClient.signOut`
directly. Account deletion keeps its separate deletion-receipt lifecycle.
