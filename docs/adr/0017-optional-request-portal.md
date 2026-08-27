# ADR 0017: Add an optional privacy-request portal to each deployment instance

- Status: accepted; production release remains gated
- Date: 2026-08-26

## Context

A host application needs an app-independent account-deletion and privacy-request
channel without adding a paid mailbox, a second deletion authority, or a shared
multi-product service. The public repository must remain product-neutral, and a
request record has different retention and restore semantics from application
data.

The initial design proposed four `RequestCases` operations. A usable no-email
operator flow also needs to discover pending cases. Hiding that query behind a
generic repository or making operators query D1 directly would weaken the
module boundary.

## Decision

1. Add a disabled-by-default request portal to the existing Worker. It runs only
   on one exact configured custom origin and has a separate `REQUEST_DB` D1
   binding and migration directory.
2. Keep a deep `RequestCases` module with five narrow operations: `open`,
   `view`, `review`, `resolve`, and `purge`. `review` returns at most 50 pending
   cases and is the only addition required for an operable no-notification
   queue. No generic storage interface is introduced; Miniflare D1 is the test
   substitute.
3. Use external adapters only for Google ID-token verification, Turnstile, and
   Cloudflare Access. Google proof is one-shot and creates neither a Better Auth
   session nor a new application account. Native sign-in remains unchanged and
   continues to use Better Auth under ADR 0014.
4. Keep one pending account-deletion case per keyed Google-subject fingerprint
   with a D1 partial unique index. Rotate its 192-bit receipt with a
   receipt-version compare-and-set. A concurrent loser returns `409` rather
   than invalidating the winning receipt.
5. Use the case UUID as the existing account-deletion operation ID. Completion
   requires the APP_DB deletion receipt and proof that the deleted account
   generation is absent. A later generation for the same Google subject is not
   deleted during reconciliation. Operators cannot manually mark an automated
   deletion as completed.
6. Store only receipt digests. Browser links place the bearer in a URL fragment,
   remove it with `history.replaceState`, and submit it in a POST body. Request
   and response text are plain text limited to 4 KiB.
7. Give text-bearing pending requests a deployment-configured maximum age from
   their immutable receipt time. Expiry reuses `rejected` with outcome
   `expired`; account-deletion sagas are excluded. Retain terminal details for
   at most seven more days. Before deletion, append the case UUID, request-DB
   generation, purge time, and schema version to an update/delete-protected
   APP_DB ledger. Every portal route reapplies and verifies that ledger before
   serving restored REQUEST_DB data; failure keeps the portal closed.
8. Protect the operator routes with Cloudflare Access and verify the assertion's
   signature, issuer, exact application audience, time claims, application type,
   and exact email allowlist inside the Worker.
9. Provide an Email Worker handler that calls only `setReject()`. Product routing
   configuration may send a published support address to it, but the handler
   does not read sender, recipient, headers, subject, or body.
10. Keep `REQUEST_PORTAL_ENABLED`, web account deletion, and the unauthenticated
    identity-issue path as separate fail-closed flags. Product domains, names,
    scopes, policy versions, resource IDs, secrets, Access policy, and release
    evidence remain in the private deployment repository.

## Deliberate limits

There is no email inbox or outbound mail, attachment, rich text, CRM, search,
assignment, internal comment, bulk action, Queue, KV, R2, analytics, webhook,
custom administrator account, workflow engine, or separate deletion Worker.
`review` is FIFO and bounded; add operational features only after measured need.

## Release gate

The example configuration keeps the portal and web deletion off. A private
deployment must not enable them until its legal notice and evidence retention
version, Turnstile host, Google JavaScript origin, Access application and exact
operator allowlist, custom-domain-only routing, D1 generations, both migration
sets, restore rehearsal, and app-account deletion recovery ledger are verified.
The public source does not create or deploy those external resources.

## Sources verified for this decision

- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Cloudflare Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Cloudflare Email Worker API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Google Identity Services JavaScript reference](https://developers.google.com/identity/gsi/web/reference/js-reference)
- [Google ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [jose remote JWKS](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md)
