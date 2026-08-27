# Contributing

Cloudflare Mobile Sync is a small self-hosted starter. Changes should preserve
its platform-neutral HTTP API, local-first clients, isolated deployments, and
deny-by-default authorization model.

## Development

1. Use Node.js 22.13 through 24 and pnpm 11.9.0.
2. Run `pnpm install --frozen-lockfile`.
3. Copy `apps/worker/.dev.vars.example` to the ignored `.dev.vars` file and use
   placeholder or local-only credentials.
4. Run `pnpm --filter @cloudflare-mobile-sync/worker migrate:local`.
5. Run `pnpm check` and `pnpm security:audit` before submitting a change.

Every D1 schema change requires a new migration tested against disposable local
state. Every authorization change requires negative tests, not only a happy
path. Keep documentation and ADRs synchronized with consequential decisions.

Do not commit secrets, tokens, `.env` files, D1 exports, production data, or
provider responses. Report security issues through [SECURITY.md](./SECURITY.md),
not a public issue.
