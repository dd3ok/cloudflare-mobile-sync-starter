# ADR 0013: Separate public platform source from private product deployments

Status: accepted

Reviewed: 2026-08-19

## Context

Cloudflare Mobile Sync is public MIT-licensed source used by multiple first-party products and by
independent adopters. Keeping real first-party deployment manifests and operational history in the
public platform repository couples generic changes to maintainer products, while one shared
multi-product runtime would expand authorization, deletion, migration, and incident blast radius.
Copying the platform into every product repository would instead create security and migration drift.

## Decision

- Keep `cloudflare-mobile-sync` as the product-neutral public Platform Source.
- Store deployable examples, validation rules, and placeholder configuration in the public repository.
- Move real product deployment manifests and operational records to a separate private deployment
  repository.
- Operate one Deployment Instance per Host Application and deployment environment. A Deployment
  Instance does not contain multiple products or act as a tenant router.
- Keep Product Accounts, provider configuration, secrets, data, migrations, deletion, recovery, and
  rollback isolated per Deployment Instance.
- Share behavior through versioned Platform Source releases and small product-neutral interfaces, not
  product-name branches in the implementation.
- Until immutable release artifacts exist, each Deployment Instance pins a reviewed full commit SHA
  and tree in its own deployment lock. A branch, tag, or shared mutable catalog entry is not deployment
  authority.
- Treat migrations as append-only release inputs. Adopters record each migration path and content
  digest because D1 records applied migration names, not a deployment-wide source revision.
- Treat a Hosted Service, cross-product Product Account, package-registry publication, and one-click
  provisioning as separate future decisions justified by demonstrated demand.
- Migrate existing maintainer configuration only after an equivalent private source of truth and its
  validation path exist. Do not delete or repoint a running configuration during the split.

## Considered options

- **One public repository containing real product deployments** was rejected because it mixes
  contributor-facing source with maintainer operations and makes generic releases product-aware.
- **One shared multi-product runtime** was rejected because a missed product scope could expose data
  across products and because deletion, migration, outage, and OAuth ownership would become coupled.
- **A platform copy inside every product repository** was rejected because fixes and migrations would
  drift between copies.

## Consequences

The public repository stays useful to outside adopters without becoming a hosted service. The
maintainer keeps one private deployment repository and must pin each product deployment to a reviewed
Platform Source revision. Platform changes remain backward-compatible during staged product rollouts,
and each product can migrate, roll back, delete data, or recover without affecting another product.

Small lock-file duplication is intentional: changing one Deployment Instance must not change another
through indirection. A commit pin still requires review, successful CI, dependency-lock verification,
and migration compatibility; it only proves identity, not safety by itself.

This decision refines ADR 0005 and supersedes ADR 0004 only where ADR 0004 places real maintainer
Wrangler configuration in the public Platform Source repository.
