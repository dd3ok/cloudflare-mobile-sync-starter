# Compatibility research index

Reviewed: 2026-08-19

## Current pinned baseline

| Area | Selection | Status |
| --- | --- | --- |
| Mobile | Expo SDK 57 / React Native 0.86 | supported; native build required |
| Native Google | `react-native-nitro-google-signin` 2.0.0 | conditional pending signed-device gate |
| Nitro runtime | `react-native-nitro-modules` 0.36.5 | exact reference-app pin |
| Authentication | Better Auth and `@better-auth/expo` 1.6.23 | direct ID-token path verified from exact source |
| Worker | Hono + Cloudflare Workers | active |
| Database | Better Auth direct D1 + platform migrations | active |
| Other providers/platforms | iOS, Kakao, Naver | not implemented |

The detailed evidence, API behavior, token-persistence analysis, nonce design,
Google client mapping, removal conditions, and official sources are in
[Android native Google authentication baseline](./research/ANDROID_NATIVE_GOOGLE_AUTH_BASELINE_2026-08-19.md).
The binding decision is [ADR 0014](./adr/0014-native-google-id-token-authentication.md).

## Dependency policy

- Pin direct dependencies and commit `pnpm-lock.yaml`.
- Keep native-library types behind `NativeGoogleCredentialProvider`.
- Do not combine the native architecture cutover with a Better Auth 1.7 upgrade.
- Re-run official Expo, Android, Google, Better Auth, and Cloudflare research
  before dependency or provider expansion.
- Run `pnpm check`, `pnpm security:audit`, and the signed physical-device gate
  before release promotion.

## Core official sources

- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)
- [Expo Google authentication](https://docs.expo.dev/guides/google-authentication/)
- [Android Credential Manager Sign in with Google](https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation)
- [Google server ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Better Auth Expo integration](https://www.better-auth.com/docs/integrations/expo)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
