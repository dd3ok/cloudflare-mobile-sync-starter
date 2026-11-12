# Self-hosting

Reviewed: 2026-08-26

This repository provides Platform Source. A real installation needs a separate
private deployment configuration for each host app and environment.

## Prerequisites

- Node.js 22.13+ (22.x) / 24.3+ (24.x) and pnpm 11.9.0
- Cloudflare account with Workers, D1, rate limits, and a managed custom domain
- Google Cloud project for the environment
- Web OAuth client ID
- Android OAuth client bound to the exact package and signing SHA-1
- Expo SDK 58 development/release build capability

## Prepare source

```bash
pnpm install --frozen-lockfile
pnpm check
```

Do not deploy `apps/worker/wrangler.jsonc` unchanged. Copy the supported overlay
fields into a private deployment instance and replace every example resource
identity.

Required public vars:

```json
{
  "ALLOWED_COLLECTIONS": "your-app-notes-v1",
  "BETTER_AUTH_URL": "https://sync.example.com",
  "GOOGLE_WEB_CLIENT_ID": "123-example.apps.googleusercontent.com",
  "NATIVE_APPLICATION_ID": "com.example.app",
  "TRUSTED_ORIGINS": "com.example.app://"
}
```

Required Worker secret names:

```text
BETTER_AUTH_SECRET
BETTER_AUTH_SECRETS
```

Both secrets need at least 32 random bytes. Store them only through Wrangler or
your protected CI environment. Google Web client ID is public metadata; there is
no Google client secret.

The request portal is optional and disabled in the example. If adopted, create
a second isolated D1 binding named `REQUEST_DB`, apply its separate migrations,
configure a custom-only request origin, Google Authorized JavaScript Origin,
Turnstile widget, and Cloudflare Access application, then supply the portal vars
and two additional Worker secrets documented in
[configuration](./CONFIGURATION.md). Keep web deletion and the identity-issue
path false until their deployment-specific release gates pass.

## Google setup

Create Web and Android clients in the same environment-specific Google Cloud
project. Configure the Android client with the installed artifact's application
ID and SHA-1. Use the Web client ID for both Credential Manager's server client
ID and the Worker's `GOOGLE_WEB_CLIENT_ID`. No redirect URI is used.

## Deploy from the private instance

The private deployment must:

- pin a full reviewed source commit and migration hashes;
- use one Worker/D1/custom domain/app/environment;
- set `workers_dev: false` and `preview_urls: false` for production;
- require only the two Better Auth secrets;
- apply migrations forward-only before Worker promotion; and
- record verification evidence without tokens or personal data.

Cloudflare and Google console changes are not authorized by this source guide.
Use your approved deployment workflow and review the exact resource targets
before any remote command.

## Consumer integration

The app calls `createExpoAuthClient`, supplies a
`NativeGoogleCredentialProvider` to `createNativeGoogleAuth`, and creates its
sync client with the same canonical HTTPS base URL. The reference app shows the
Credential Manager adapter and fallback order.

Use a development build, not Expo Go. Production approval additionally requires
the Play App Signing SHA-1 and the signed physical-device test matrix in
[Google setup](./PROVIDERS.md).

## Windows reference-app builds

Windows native builds can exceed the platform path limit inside pnpm's isolated
package directories. Use a fresh, short-path checkout for native verification
and set `nodeLinker: hoisted` in that checkout's `pnpm-workspace.yaml` before the
first `pnpm install --frozen-lockfile`. Keep this local layout override out of
source commits; the canonical workspace and CI continue to use isolated installs.
The reference app's `index.ts` supports either layout.

Install Android SDK CMake 3.31.6 and pass `-Pandroid.cmakeVersion=3.31.6` to the
local Gradle build. For example, after Android prebuild, run from the generated
`examples/expo-app/android` directory:

```powershell
./gradlew.bat :app:assembleDebug -PreactNativeArchitectures=x86_64 -Pandroid.cmakeVersion=3.31.6 --no-daemon
```

This builds an emulator-architecture debug APK; it does not validate a signed
production build or real provider sign-in. Do not set this local CMake version
for hosted Linux builds. See the official [Expo Windows path guidance](https://docs.expo.dev/troubleshooting/windows-long-paths/)
and [monorepo installation guidance](https://docs.expo.dev/guides/monorepos/#package-managers-with-isolated-dependencies).
