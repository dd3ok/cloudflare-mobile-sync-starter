# Configuration contract

Reviewed: 2026-08-26

Configuration is split by trust boundary. Portable packages accept explicit
options and never read environment variables.

## Worker bindings

| Name | Kind | Purpose |
| --- | --- | --- |
| `DB` | D1 binding | isolated service database |
| `AUTH_RATE_LIMITER` | binding | authentication abuse limit |
| `SYNC_RATE_LIMITER` | binding | sync write/read limit |
| `ALLOWED_COLLECTIONS` | public var | exact sync collection allowlist |
| `RETAINED_TOMBSTONE_TARGETS` | public var | optional strict compaction targets |
| `BETTER_AUTH_URL` | public var | canonical HTTPS Worker origin |
| `TRUSTED_ORIGINS` | public var | exact Better Auth origins; no wildcard |
| `GOOGLE_WEB_CLIENT_ID` | public var | Google ID-token audience |
| `NATIVE_APPLICATION_ID` | public var | exact Android application ID |
| `BETTER_AUTH_SECRET` | Worker secret | active session-signing secret |
| `BETTER_AUTH_SECRETS` | Worker secret | versioned rotation keyring |

The optional request portal additionally uses a separate `REQUEST_DB` D1
binding. All portal variables are ignored while `REQUEST_PORTAL_ENABLED` is not
exactly `true`.

| Name | Kind | Purpose |
| --- | --- | --- |
| `REQUEST_PORTAL_ORIGIN` | public var | exact custom HTTPS origin; `workers.dev` is rejected |
| `REQUEST_PORTAL_ORGANIZATION_NAME` | public var | neutral organization display name |
| `REQUEST_PORTAL_PRODUCT_NAME` | public var | host-product display name |
| `REQUEST_PORTAL_PUBLIC_SCOPE` | public var | organization inquiry scope identifier |
| `REQUEST_PORTAL_ACCOUNT_SCOPE` | public var | host-product request scope identifier |
| `REQUEST_PORTAL_NOTICE_VERSION` | public var | released notice/consent version |
| `REQUEST_EVIDENCE_POLICY_VERSION` | public var | released evidence-retention policy version |
| `REQUEST_PORTAL_PENDING_MAX_AGE_DAYS` | public var | whole-day maximum pending interval, from 1 through 365; example `30` |
| `REQUEST_DB_GENERATION` | public var | deployment-owned request database generation |
| `REQUEST_PORTAL_TURNSTILE_SITE_KEY` | public var | hostname-restricted widget key |
| `REQUEST_PORTAL_ACCESS_TEAM_DOMAIN` | public var | exact Access issuer origin |
| `REQUEST_PORTAL_ACCESS_AUDIENCE` | public var | exact Access application AUD tag |
| `REQUEST_PORTAL_ADMIN_EMAILS` | public var | comma-separated exact operator allowlist |
| `REQUEST_PORTAL_TURNSTILE_SECRET_KEY` | Worker secret | Siteverify credential |
| `REQUEST_SUBJECT_HMAC_KEY` | Worker secret | keyed subject-fingerprint key |

`REQUEST_PORTAL_ACCOUNT_DELETION_ENABLED` and
`REQUEST_PORTAL_IDENTITY_ISSUE_ENABLED` are independent release flags and
default to false. Do not put real names, domains, generations, audiences,
emails, widget keys, D1 IDs, or policy versions in this public repository.
The pending interval is measured from the immutable receipt time. Text-bearing
cases that reach it become `rejected/expired`, then follow the existing
seven-day terminal-detail purge. The effective maximum plain-text lifetime is
therefore this interval plus seven days; choose and document the value in the
deployment's released retention policy.

There is no `GOOGLE_CLIENT_SECRET`, generic `*_CLIENT_ID`, provider refresh
token, or OAuth callback variable in the native baseline. The Web client ID is
not a secret and is returned to the app as part of a nonce attempt.

`BETTER_AUTH_URL` is one canonical custom-domain origin such as
`https://sync.example.com`. Do not mix a custom domain, `workers.dev`, and a
different app URL in one environment. Product deployments should set
`workers_dev: false` and `preview_urls: false` after the custom domain is ready.

## Environment isolation

Every environment has its own:

- Google Cloud project;
- Web OAuth client ID;
- Android OAuth client bound to exact package and signing SHA-1;
- Worker, D1 database, rate-limit namespaces, custom domain, application ID,
  collection namespace, and Better Auth secrets.

A deployment accepts one Web audience only. Do not add dev and production client
IDs to one Better Auth configuration.

## Expo consumer

The consuming app needs only public values:

```dotenv
EXPO_PUBLIC_MOBILE_SYNC_URL=https://sync.example.com
EXPO_PUBLIC_MOBILE_SYNC_PROVIDERS=google
```

The native application ID remains in Expo config. The Worker returns the Web
client ID at sign-in, so the app does not need a second copy. All
`EXPO_PUBLIC_*` values are visible in the bundle; never place secrets or tokens
there.

Use an Expo development or release build. Expo Go cannot load the Credential
Manager native module. `react-native-nitro-google-signin` 2.0.0 and
`react-native-nitro-modules` 0.36.5 are exact pins in the reference app.

## Deployment ownership

The committed `apps/worker/wrangler.jsonc` is a local/example config only.
Product configs belong in a private deployment repository and must pin this
repository by full commit plus migration hashes. Never restore real product D1
IDs or Google project identities to this public source repository.
