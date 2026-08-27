# Security policy

## Supported versions

Cloudflare Mobile Sync does not have a stable release yet. Security fixes are
applied to `main`; tagged `0.x` releases remain pre-release software. Public
source availability is not a claim that every provider and platform has passed
the real-device gates in
[the public-release checklist](./docs/PUBLIC_RELEASE.md).

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use
GitHub private vulnerability reporting from this repository's **Security** tab.
The repository owner must configure a non-public fallback contact before
publishing the source from a host that does not provide private reporting.

Include the affected commit or version, reproduction steps, expected impact,
and any safe proof of concept. Never include real OAuth credentials, session
cookies, Cloudflare tokens, provider tokens, database exports, or user data.

## Scope

Reports about authentication bypass, cross-user access, account linking,
session handling, OAuth redirects, secret exposure, destructive account
deletion, and sync authorization are especially useful. Operational issues in
an adopter's own Cloudflare or provider account should first be reduced to a
reproducible problem in this repository.

The implementation's trust boundaries and known constraints are documented in
[the security model](./docs/SECURITY.md).
