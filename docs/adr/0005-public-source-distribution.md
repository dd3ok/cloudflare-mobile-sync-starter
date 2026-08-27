# ADR 0005: Distribute a public self-hosted source starter

Status: accepted

Reviewed: 2026-07-23

## Context

Other developers should be able to use the generic authentication and sync
implementation. Letting unrelated applications call the maintainer's deployed
Worker would mix accounts, quotas, deletion scope, and application data in one
service. Publishing all SDK packages to npm now would add versioning and support
work before a real host app has completed the provider/device gate.

## Decision

- License the repository source under MIT.
- Prepare the repository for public visibility as a CLI-first self-hosted
  starter.
- Require every adopter to deploy an independent Worker and D1 database and to
  create their own provider applications and secrets.
- Keep every workspace package `private: true` and unpublished for the first
  source release. Developers can fork the workspace, use its HTTPS contract, and
  run the included Expo example without an npm release.
- A separately owned first-party app may vendor local archives of all three
  client packages built from one pinned commit. The archives must use built
  `dist` exports, include their MIT notices, and be locked by the consumer. This
  does not make the packages public or establish a compatibility promise.
- Keep the maintainer deployment private to its intended apps; it is a reference
  deployment, not a public sandbox or shared SaaS.
- Treat source publication and provider/platform production claims as separate
  gates. The repository may be published as `0.x` pre-release source while a
  platform remains explicitly unverified; it must not claim that platform or
  provider is production-ready until its real-device flow passes.
- Require the public-release checklist before changing repository visibility or
  creating the first tag.

## Consequences

The first distribution remains small: source, documentation, tests, and a
reproducible per-adopter deployment. It avoids tenant provisioning, billing,
shared-service incident response, and premature package compatibility promises.

Adopters must own Cloudflare operations, OAuth configuration, privacy terms,
backups, provider reviews, and end-user support. Separate repositories may use
the HTTP contract or the complete pinned archive set; copying one internal
package in isolation is not a supported installation method.

The maintainer's Expo and non-Expo clients exercise two different consumer
boundaries. This supports the platform-neutral HTTP design, but it is not a
substitute for iOS verification, provider review, or a compatibility guarantee.
Those claims remain limited to the flows recorded as verified.

## Sources

- [Cloudflare Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/workers/wrangler/commands/d1/)
- [Better Auth Expo integration](https://better-auth.com/docs/integrations/expo)
- [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
