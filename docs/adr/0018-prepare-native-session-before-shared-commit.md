# ADR 0018: Prepare native sessions before shared commit

- Status: accepted
- Date: 2026-08-27

## Context

Better Auth's Expo plugin installs a direct ID-token sign-in cookie before the
host operation can bind the returned user to its account-transition
coordinator. A session observer can therefore cancel the operation with its own
new session. More critically, cleanup that starts after another account has
replaced the shared cookie can revoke or clear the replacement account instead
of the session created by the failed sign-in attempt.

A user identifier is not session ownership. Two sessions for the same user must
also remain distinguishable without returning a cookie or session token to the
host application.

## Decision

- Native direct sign-in uses the existing Better Auth endpoint through a raw
  credential-omitting request. Its response cookie and session token remain in
  an in-memory prepared-session closure and are not installed in shared
  SecureStore yet.
- `NativeGoogleAuth.signIn` returns the user plus an opaque prepared-session
  handle with synchronous `commit` and asynchronous `abort` operations. Tokens
  and cookies are never returned by that interface.
- The Expo adapter captures the shared cookie and an in-memory mutation epoch
  before the provider flow starts. `commit` installs the prepared cookie only
  when both values are unchanged. A replacement session and cookie ABA both
  fail closed.
- The shared cookie is the single account-bearing commit point. The owned Expo
  adapter disables Better Auth's persistent session-data cache, clears any old
  cache entry during an explicit ownership transition, writes the cookie
  synchronously, and then signals Better Auth to refresh. The package-private
  storage layer follows Better Auth Expo 1.6.23's normalized-key, 1,800-character
  chunk boundary and reads its legacy marker. New large values stage into the
  inactive one of two bounded chunk slots and switch the base marker last, so a
  partial write preserves the previous cookie. Every completed write is read
  back; storage errors propagate instead of being logged and hidden.
- The adapter observes every Better Auth cookie base or chunk write and advances
  the mutation epoch synchronously when the logical cookie changes. Concurrent
  response hooks therefore invalidate A-to-B-to-A ownership before either hook
  resumes from an asynchronous boundary.
- Every Better Auth request privately tags the mutation epoch in the same init
  step that adds its cookie header, then rejects the request if that tag is stale
  immediately before fetch. Complete init and success-hook applications pass
  through one small FIFO gate. The epoch is also checked before every cookie
  write and after the hook; a large cookie is committed only if its chunk
  sequence is still current. An older in-flight request therefore cannot restore
  a cookie or report stale success after logout or deleted-account cleanup.
- The host validates its serialized account operation, commits the prepared
  session, and publishes the returned subject in the same JavaScript call
  stack. The prepared session is invisible to React session observers before
  that point.
- `abort` revokes only the prepared session by sending its private cookie and
  token to the authoritative revoke endpoint. Native credential state is
  cleared only if the captured shared-session baseline is still current.
- Commit and abort are mutually exclusive. Abort is idempotent and retryable
  after an indeterminate remote failure; abort after commit is rejected.
- Logout and deleted-account cleanup capture the same opaque cookie-and-epoch
  ownership token. Authoritative reads and revocation send that captured cookie
  with `credentials: omit` instead of using the shared Better Auth client, so a
  response cannot mutate local storage before the token is compared and cleared.
- Raw Better Auth requests derive their endpoint from the configured `authPath`
  and use a bounded request timeout and response body, reject redirects, and
  require a JSON content type and validated response shape. Deleted-account
  cleanup clears only a definitively stale session or the expected subject and
  preserves a replacement subject.

## Consequences

No Worker route, D1 schema, deployment binding, secret, OAuth client, or domain
changes are required. The direct sign-in and revoke endpoints are unchanged.
Native hosts must explicitly commit a successful prepared sign-in and abort any
result they cannot attach to the still-current account operation.

The shared-session mutation epoch is process-local by design: a prepared handle
cannot survive an app restart, and a restart discards both the handle and its
private in-memory credentials.
