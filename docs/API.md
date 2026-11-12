# HTTP API

Reviewed: 2026-08-26

All responses are JSON unless documented otherwise. The Worker derives the user
from the Better Auth session; client-supplied user IDs are never authorization
inputs.

## Endpoints

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | D1 readiness and protocol version |
| `POST` | `/v1/native-auth/google/attempts` | none; rate-limited | issue a five-minute native nonce attempt |
| `POST` | `/v1/auth/sign-in/social` | one-time attempt + Google ID token | create a Better Auth session |
| `GET` | `/v1/auth/get-session` | session | restore current session |
| `POST` | `/v1/auth/sign-out` | session | revoke current session |
| `POST` | `/v1/sync/push` | session | apply up to 25 ordered mutations |
| `POST` | `/v1/sync/retained-tombstone` | session | compact a configured non-sensitive marker |
| `GET` | `/v1/sync/pull` | session | pull bounded changes after a cursor |
| `GET` | `/v1/account` | session | current profile and provider identifiers |
| `DELETE` | `/v1/account` | fresh session | delete service data and return a receipt |
| `POST` | `/v1/account-deletions/status` | deletion capability | recover a completed deletion receipt |

When the optional request portal is enabled on its exact custom origin, it also
provides:

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| `GET` | `/`, `/en/` | none | paired request and receipt-view pages |
| `POST` | `/api/google-challenge` | same origin; rate-limited | issue a five-minute one-shot web nonce |
| `POST` | `/api/cases` | Google proof or Turnstile | open or resume one request |
| `POST` | `/api/cases/view` | secret receipt; rate-limited | read the public status and response |
| `GET` | `/admin/` | Access JWT + exact operator | review up to 50 pending cases |
| `POST` | `/admin/cases/:id/resolve` | Access JWT + exact operator | resolve one non-deletion case once |

Portal POSTs require an exact `Origin` match and JSON bodies. Request and
response text are UTF-8 plain text capped at 4 KiB. Receipt secrets are never
accepted in a query or path. Automated account-deletion cases cannot be marked
complete through the administrator endpoint. Text-bearing cases left pending
for the configured maximum age become `rejected` with outcome `expired`, then
reuse the seven-day terminal-detail purge.

Google browser callbacks and `/v1/auth/link-social` return `404`. A social
sign-in request without the exact native ID-token body returns `400`.

## Native Google attempt

Request:

```json
{ "applicationId": "com.example.app" }
```

Response:

```json
{
  "attemptId": "64-lowercase-hex-characters",
  "nonce": "64-lowercase-hex-characters",
  "webClientId": "123-example.apps.googleusercontent.com",
  "expiresAt": "2026-08-19T12:05:00.000Z"
}
```

The application ID must equal the deployment's `NATIVE_APPLICATION_ID`. D1
stores only the nonce SHA-256 digest. The attempt expires within five minutes
and can be consumed once.

The subsequent Better Auth request must have this exact shape:

```json
{
  "provider": "google",
  "idToken": {
    "token": "google-signed-jwt",
    "nonce": "the-server-issued-nonce"
  },
  "additionalData": {
    "nativeAttemptId": "the-server-issued-attempt-id"
  }
}
```

Unknown fields, access/refresh tokens, caller profiles, callback URLs, another
provider, a mismatched nonce, an expired attempt, or a replay fail closed.
Better Auth then verifies signature, issuer, audience, expiry, maximum age, and
nonce before creating its user/account/session rows.

## Sync

`POST /v1/sync/push` accepts 1–25 compare-and-set mutations. A create uses
`baseRevision: 0`; updates and deletes must use the exact current revision.
Mutation IDs are idempotency identities and must not be reused for another
logical mutation.

`GET /v1/sync/pull?cursor=0&limit=50&collection=notes` returns changes ordered
by a global cursor after user and optional exact-collection filtering. The
default page size is 50 and maximum is 100. Cursor gaps are normal. Each filtered
collection keeps its own cursor.

Deletes remain as tombstones while older payload snapshots are compacted. See
[sync retention](./SYNC_RETENTION.md) for reset and retention rules.

## Account deletion

Deletion requires:

- a session created within the previous 24 hours;
- `X-Mobile-Sync-Expected-Subject` equal to the current session user; and
- a durable UUID-v4 `X-Mobile-Sync-Deletion-Operation`.

The Worker deletes the service user, sessions, provider-account row, and sync
data regardless of Google availability. Because the native baseline stores no
Google access token, server-side provider revocation is `unconfirmed`. A client
may request native Google disconnect before deletion, but failure must not block
service-data deletion. A PII-free receipt remains recoverable for seven days.

Before sending `DELETE`, the client must durably journal the expected subject
and operation ID. `client-core` provides `deleteAccountRecoverably` to enforce
that ordering and `recoverAccountDeletion` to query the same capability after a
lost response or process restart. The host clears the journal only after it has
detached local metadata for that subject and conditionally cleared the matching
session; a replacement account must be preserved.

## Errors

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "retryable": false
  }
}
```

Client logic uses `code` and `retryable`, not message text. Exact schemas and
limits live in `packages/api-contract/src/index.ts`.
