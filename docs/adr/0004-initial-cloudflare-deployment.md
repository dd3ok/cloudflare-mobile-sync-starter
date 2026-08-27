# ADR 0004: Prepare the first Cloudflare deployment on workers.dev

Status: accepted

Deployment-configuration placement partially superseded by ADR 0013.

Reviewed: 2026-08-13

## Context

At decision time, the authenticated owner account had no Cloudflare zones, D1
databases, or Workers. A stable HTTPS origin is needed before OAuth callbacks and
consuming applications can be configured. Buying or transferring a domain is not
required for the first end-to-end verification.

## Decision

- Create the account subdomain `maintainer-account.workers.dev`.
- Prepare the Worker at
  `https://cloudflare-mobile-sync.maintainer-account.workers.dev`.
- Create the isolated D1 database `cloudflare-mobile-sync-prod` in APAC and keep
  the Worker binding name `DB`.
- Keep one committed Wrangler configuration per independently deployed
  maintainer Worker. The two maintainer consumers use separate
  Workers, D1 databases, rate-limit namespaces, trusted origins, collections,
  and secrets. Local development overrides runtime values through the ignored
  `.dev.vars` file.
- Treat the primary configuration's original `com.example.legacy*` origins and
  v1 collections as a legacy compatibility boundary. The official production
  `com.example.firstparty` app uses a separate
  `first-party-sync-production` Worker and D1 deployment provisioned on
  2026-08-18. Development and preview remain pending. Consumer activation still
  requires a reviewed artifact and physical Android E2E; it must never repoint
  the legacy deployment.
- Disable preview URLs because this project has no preview deployment workflow.
- Keep required secret *names* in `apps/worker/required-secrets.json`, keyed by
  Wrangler filename, instead of a non-schema `secrets` block in Wrangler. The
  current maintainer deployments require the two Better Auth bindings
  and the Google client ID and secret. Secret values remain outside Git.
- Validate each committed Wrangler file against the schema shipped by the pinned
  Wrangler version, validate the manifest and fail-closed origin/collection
  policies locally, and compare remote secret names before a remote mutation.
  The preflight must never read or print secret values.
- Upload initial secret values together with the first Worker deployment.
- Do not apply remote migrations or deploy Worker code until the owner explicitly
  starts the deployment step.

The owner authorized that step on 2026-07-21. Both committed migrations were
applied and the Worker was deployed with its Better Auth and Google credentials
stored as Worker secrets outside Git.

## Consequences

This is the smallest deployment shape: one Worker and one D1 database, with no
KV, R2, Queue, Durable Object, staging Worker, or custom-domain dependency. The
`workers.dev` origin is public and suitable for the initial verification, but
Cloudflare recommends a Worker Custom Domain or route for business-critical
production use. Adding a custom domain later requires updating Better Auth,
consumer app URLs, and every provider callback together.

The D1 database ID is account-specific but is not a credential. Secrets remain
outside Git in an ignored file and are encrypted by Cloudflare when uploaded.
The resulting maintainer deployment is not a public sandbox; public source
distribution is governed by ADR 0005 and requires per-adopter deployments.
Adding or removing a provider now requires a coherent provider, manifest, test,
and documentation change; a missing required name fails preflight before remote
state is mutated.

## Sources

- [Cloudflare Workers routes and domains](https://developers.cloudflare.com/workers/configuration/routing/)
- [Cloudflare workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
