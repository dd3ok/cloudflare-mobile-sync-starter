# Google authentication setup

Reviewed: 2026-08-19

The active baseline supports Android Google sign-in through Credential Manager.
It does not use browser OAuth or a redirect URI.

## Per environment

Create one Google Cloud project for each environment. In each project create:

1. A **Web application** OAuth client. Its client ID is the Credential Manager
   server client ID, the Google ID-token `aud`, and the Worker's
   `GOOGLE_WEB_CLIENT_ID`.
2. An **Android** OAuth client bound to the exact application ID and the SHA-1 of
   the certificate that signs the installed APK/AAB.

The two clients must be in the same project. Never use the Android client ID as
the Web audience. Never put a client secret in the app or Worker; direct ID-token
sign-in does not need one.

For development, register the actual EAS/dev signing SHA-1 and development
package. For Google Play production, register the Play App Signing SHA-1 for the
production package; the upload-key SHA-1 is not a substitute for the certificate
on the installed Play artifact.

## Branding

OAuth consent branding still needs a public product homepage, privacy policy,
terms, account deletion URL, verified domain, support email, and matching app
name. These are trust and policy surfaces, not redirect URLs.

## Device gate

Before production approval verify on the exact signed build:

- returning authorized account;
- new account picker and explicit Google-button fallback;
- cancellation, network failure, outdated Play Services, and developer error;
- wrong audience, nonce mismatch, expired attempt, consumed attempt, and replay;
- session restore after restart, logout, and account deletion;
- dev credentials rejected by production and vice versa;
- provider token columns remain null.

Kakao, Naver, iOS, offline access, server auth codes, Google API scopes, and
refresh tokens are not configured. Add them only as separate provider-specific
proof-to-server designs.

Official references:

- [Android Credential Manager Sign in with Google](https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation)
- [Google Android client setup](https://developers.google.com/identity/sign-in/android/start-integrating)
- [Google server ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Expo Google authentication](https://docs.expo.dev/guides/google-authentication/)
