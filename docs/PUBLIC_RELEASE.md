# Public source release checklist

Reviewed: 2026-08-19

Source publication, package publication, a hosted service, and product
production-readiness are separate decisions.

## Source release

- [x] MIT license and security-reporting path
- [x] product-neutral source/deployment boundary
- [x] CI, dependency audit, current/default-branch-history secret scan, strict
      TypeScript, and Workers tests
- [x] native Google nonce and browser-bypass negative tests
- [x] append-only D1 migrations and local disposable migration coverage
- [x] self-hosting, configuration, security, and operations documentation
- [x] package manifests remain `private: true`
- [ ] commit the native baseline from a clean worktree
- [ ] verify public CI on the exact commit
- [ ] publish an immutable pre-release and attach reviewed provenance

The dependency audit currently has two time-bounded Expo/Metro build-tool
exceptions documented in the security model. They have no published patched
release and expire fail-closed on 2026-09-12 UTC; they are not a clean-audit
claim.

## Product release blockers

- [ ] environment-specific Web and Android OAuth clients exist in the correct
      Google Cloud projects
- [ ] package names and actual dev/Play signing SHA-1 values are verified
- [ ] production custom domain and `BETTER_AUTH_URL` are identical
- [ ] dev credentials are rejected in production and vice versa
- [ ] production-signed Android device matrix in `PROVIDERS.md` passes
- [ ] Google provider-token columns remain null after real sign-in
- [ ] account deletion, native disconnect failure, restore reconciliation, and
      deletion receipt recovery are rehearsed
- [ ] Cloudflare plan, D1 Time Travel window, log retention, and external
      deletion ledger are recorded with evidence

No prior browser OAuth, callback, or other-consumer verification satisfies the
new native Credential Manager gate.

## Deferred

- npm publication
- one-click deployment
- hosted/multi-tenant service
- iOS, Kakao, Naver, Google API scopes, offline access, refresh tokens, and
  automatic provider linking
- Better Auth 1.7 migration, which must be reviewed separately from this auth
  architecture change
