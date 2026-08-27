# Repository instructions

Read `HANDOFF.md` and `docs/ARCHITECTURE.md` before changing the repository.

## Documentation requirements

- Before writing Expo code, read the exact versioned Expo SDK 57 documentation at <https://docs.expo.dev/versions/v57.0.0/>. Do not substitute unversioned or older Expo examples.
- Before writing Cloudflare code, verify the current official Workers, D1, Wrangler, local development, migrations, limits, and testing documentation.
- Before configuring authentication, verify the current official Better Auth, Better Auth Expo, Google, Kakao, and Naver documentation. Prefer maintained official libraries and documented adapters over custom protocol code.

## Architecture requirements

- Keep the Worker and HTTP API platform-neutral.
- Put portable API/sync behavior in `packages/client-core`; Expo-specific SecureStore, linking, and OAuth behavior belongs only in `packages/expo-client`.
- Never expose a D1 binding, OAuth client secret, Cloudflare credential, session signing secret, or provider refresh token to a mobile bundle.
- Every application-data query and mutation must be scoped by the authenticated server-side user ID.
- Do not automatically link accounts solely because providers return the same email address.
- Preserve local-first behavior: authentication and remote synchronization are optional capabilities, not requirements for using a host application offline.
- This repository is a self-hosted starter. Do not turn it into a shared multi-tenant service without an explicit product and security decision.

## Delivery requirements

- Do not deploy production resources or create OAuth applications without explicit authorization and credentials from the owner.
- Never commit `.dev.vars`, `.env`, tokens, provider secrets, database exports, or real user data.
- Keep dependency versions pinned through the lockfile and run the proportional test, type-check, lint, and security checks before each handoff.
- Use migrations for every D1 schema change and test migrations against a disposable local database.
- Add negative authorization tests, not only happy-path tests.
- Keep documentation synchronized with implementation and record consequential design choices as ADRs.
