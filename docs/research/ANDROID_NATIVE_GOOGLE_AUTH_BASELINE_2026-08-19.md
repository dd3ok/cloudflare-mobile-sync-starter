# Android native Google authentication baseline

- 검토일: 2026-08-19 (Asia/Seoul)
- 대상: Expo SDK 57 / React Native 0.86 / Android, Better Auth 1.6.23, Cloudflare Workers + D1
- 범위: 조사와 설계 기준만 포함한다. 이 문서는 배포, Google/Cloudflare 콘솔 변경, 실제 코드 변경을 승인하지 않는다.
- 저장소 전제: `AGENTS.md`, `HANDOFF.md`, `docs/ARCHITECTURE.md`를 먼저 읽고 현재 코드 및 설치된 패키지 소스를 대조했다.

## 결론

호스트 앱의 Android Google 로그인 기준은 다음으로 잡는 것이 가장 단순하고 유지보수하기 좋다.

```text
Android Credential Manager
  -> Google ID token (Web OAuth client ID가 aud)
  -> HTTPS POST /v1/auth/sign-in/social
  -> Better Auth가 서명/iss/aud/exp/iat/nonce 검증
  -> D1 user + account(providerId, sub) + session 생성
  -> Set-Cookie를 @better-auth/expo가 SecureStore에 보관
```

브라우저 OAuth, Worker OAuth callback, private custom-scheme callback, bearer-cookie handoff는 Google Android 로그인에 필요하지 않다. 단, 아래 두 안전장치 없이 기존 흐름을 먼저 삭제하면 안 된다.

1. 서버가 발급하고 D1에서 한 번만 소비하는 짧은 수명의 nonce 시도 레코드가 필요하다. Better Auth 1.6.23은 전달받은 nonce와 토큰 claim의 일치 여부는 검증하지만 nonce의 최초 사용 여부까지 저장·검사하지 않는다.
2. 서버가 Google access/refresh/ID token을 저장하지 않는 정책을 택하면, 현재 `getAccessToken()`을 전제로 한 서버 측 Google revoke/account-deletion 경로를 함께 바꿔야 한다.

네이티브 브리지는 Expo 공식 가이드가 Credential Manager 구현으로 안내하는 `react-native-nitro-google-signin`을 좁은 adapter 뒤에 두고 정확한 버전으로 고정하는 안을 우선 권고한다. 2026-08-17에 나온 v2.0.0이 현재 최신이므로, 아키텍처 채택과 실제 출시 승인을 분리해야 한다. 실제 production 서명 빌드에서 통과하기 전에는 출시 기준으로 확정하지 않는다. 실패하면 공개 API를 유지한 채 공식 Credential Manager API를 감싼 작은 Expo Module로 교체한다.

## 공식 근거

### Expo SDK 57

- [Expo SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/)는 SDK 57이 React Native 0.86, React 19.2.3을 사용하며 Android 7+, compile/target SDK 36을 대상으로 한다고 명시한다.
- Expo의 [Google authentication guide](https://docs.expo.dev/guides/google-authentication/)는 2026-07-17 갱신 기준으로 다음을 구분한다.
  - `react-native-nitro-google-signin`: Android Credential Manager 지원
  - 무료 `@react-native-google-signin/google-signin`: Android legacy Google Sign-In SDK 사용
  - 유료 Universal Sign In: Credential Manager 지원
- 같은 가이드는 이 네이티브 라이브러리들이 Expo Go에서 동작하지 않으며 config plugin과 development build가 필요하다고 명시한다.
- Expo의 [custom native code guide](https://docs.expo.dev/workflow/customizing/)는 CNG에서 직접 생성된 `android/` 파일을 수정하기보다 config plugin을 쓰고, 공용 모듈은 standalone Expo Module로 캡슐화하도록 안내한다.

Expo의 Google 인증 가이드는 SDK별 `/versions/v57.0.0/` 경로가 없는 전역 가이드다. 따라서 정확한 SDK/RN 호환 기준은 버전 고정 SDK 57 reference로 확인하고, Google 라이브러리 선택은 2026-07-17에 갱신된 전역 공식 가이드를 적용했다. 이를 “Expo 57 전용 Credential Manager API가 Expo SDK에 내장돼 있다”는 의미로 해석하면 안 된다.

### Android / Google

- Android의 [Credential Manager Sign in with Google implementation](https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation)은 `GetGoogleIdOption`/`GetSignInWithGoogleOption`, `setServerClientId(WEB_CLIENT_ID)`, nonce, 서버 검증을 요구한다.
- 같은 문서는 returning user에 대해 authorized account를 먼저 시도하고, `NoCredentialException`이면 `setFilterByAuthorizedAccounts(false)`로 전체 계정을 제시하며, 지속적인 Google 버튼 흐름도 제공하라고 권고한다.
- 로그아웃 시에는 Credential Manager의 `clearCredentialState()`를 호출해 credential provider의 활성 상태를 지우라고 명시한다. 이는 Google 권한 자체를 철회하는 동작과는 다르다.
- Google의 공식 [Android codelab](https://codelabs.developers.google.com/sign-in-with-google-android)은 같은 Google Cloud 프로젝트에 Web client와 Android client를 모두 만들도록 설명한다. Android client는 package name + SHA-1을 등록하고, Web client는 backend/server client ID 역할을 한다.
- Google의 [server-side ID-token verification guide](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)는 서명, `aud`, `iss`, `exp` 검증과 `sub`를 불변 계정 식별자로 사용할 것을 요구한다. 이메일은 식별자로 사용하지 않는다.
- Google의 [legacy migration guide](https://developer.android.com/identity/sign-in/legacy-gsi-migration)는 Android의 legacy Google Sign-In에서 Credential Manager로 이전하는 방향을 제시한다.

### Better Auth 1.6.23

- Better Auth의 [Expo integration guide](https://www.better-auth.com/docs/integrations/expo)는 provider에서 받은 ID token을 `signIn.social({ provider: "google", idToken: { token, nonce } })`로 서버에 보내는 비리다이렉트 경로를 문서화한다.
- 설치된 1.6.23과 동일한 태그의 [`sign-in.ts`](https://github.com/better-auth/better-auth/blob/v1.6.23/packages/better-auth/src/api/routes/sign-in.ts)는 ID-token 분기에서 `provider.verifyIdToken(token, nonce)`를 먼저 실행한 뒤, provider user info를 얻고 OAuth user/account/session을 생성하며 session cookie를 설정한다.
- 동일 태그의 [`google.ts`](https://github.com/better-auth/better-auth/blob/v1.6.23/packages/core/src/social-providers/google.ts)는 Google 공개키로 서명을 검증하고 issuer를 `accounts.google.com` 또는 `https://accounts.google.com`으로, audience를 설정된 `clientId`로 제한한다. `exp`와 최대 token age 1시간을 검증하고, nonce가 전달됐을 때 claim과 정확히 일치시키며, `hd` 제한도 적용한다.
- 동일 태그의 [`link-account.ts`](https://github.com/better-auth/better-auth/blob/v1.6.23/packages/better-auth/src/oauth2/link-account.ts)는 `(providerId, accountId)`로 기존 provider account를 찾고 user/account/session을 D1에 지속한다. 현재 저장소의 `disableImplicitLinking: true` 설정은 같은 이메일만으로 새 provider subject를 기존 user에 자동 연결하지 않게 한다.
- 동일 태그의 [`@better-auth/expo` client source](https://github.com/better-auth/better-auth/blob/v1.6.23/packages/expo/src/client.ts)는 ID-token 요청에는 브라우저 OAuth proxy를 열지 않고, 응답 `Set-Cookie`의 Better Auth cookie를 native storage에 저장한다. `get-session` 결과도 SecureStore에 캐시하고, API 요청에는 `getCookie()` 결과를 명시적으로 보낼 수 있다.
- [Better Auth options](https://www.better-auth.com/docs/reference/options)는 DB가 있을 때 `storeAccountCookie` 기본값이 false이며, `disableImplicitLinking: true`가 같은 이메일의 암묵적 연결을 거절한다고 문서화한다.

Better Auth 1.6.23은 현재 저장소에 설치된 정확한 버전이지만 2026-08-19 최신 릴리스는 [1.7.1](https://github.com/better-auth/better-auth/releases/tag/v1.7.1)이다. 이 연구는 현재 동작을 1.6.23 소스로 확정한 것이지, 1.6.23을 장기 production 기준으로 권고한 것이 아니다. 1.7 계열은 ID-token verifier 구조 등에 변경이 있으므로 이 인증 전환과 한 커밋에서 무심코 올리지 말고 별도의 호환성·마이그레이션 검토를 거쳐야 한다.

## 권고 구현

### 1. 네이티브 라이브러리 경계

권고 우선순위는 다음과 같다.

1. `react-native-nitro-google-signin` v2.0.0을 정확히 고정해 `packages/expo-client`의 작은 provider adapter 뒤에서 사용한다.
2. 라이브러리의 public types를 `client-core`나 Worker 계약으로 누출하지 않는다.
3. production 서명 빌드 smoke test가 실패하거나 maintenance risk가 허용되지 않으면 같은 adapter를 유지하고 공식 Credential Manager를 감싼 standalone Expo Module로 교체한다.
4. 무료 `@react-native-google-signin/google-signin`으로 새 구현을 시작하지 않는다. Expo 공식 문서상 Android 구현이 deprecated legacy SDK다.

채택 후보의 [v2.0.0 release](https://github.com/react-native-nitro-google-sign-in/google-signin/releases/tag/v2.0.0)는 React Native 0.76+와 Expo development build를 지원한다고 선언하며, Android source는 `GetGoogleIdOption`/`GetSignInWithGoogleOption`을 사용한다. [`GoogleSignInController.kt`](https://github.com/react-native-nitro-google-sign-in/google-signin/blob/v2.0.0/android/src/main/java/com/nitrogooglesignin/GoogleSignInController.kt)에서 Web client ID와 nonce를 Credential Manager에 전달하고 `clearCredentialState`로 sign-out한다.

그러나 v2.0.0은 검토일 이틀 전에 출시됐다. Expo 57/RN 0.86에 대한 선언상 호환성은 있지만 충분한 production 이력은 없다. 따라서 이 선택은 “유지보수가 가장 쉬운 우선 후보”이지 “검증이 끝난 production 의존성”은 아니다.

### 2. 로그인 흐름

```text
1. Client -> POST /v1/native-auth/google/attempts
2. Worker:
   - 32-byte CSPRNG nonce 생성(예: 64자 lowercase hex)
   - D1에는 nonce 원문 대신 SHA-256 digest, attempt ID, expires_at, consumed_at 저장
   - TTL 5분 이하의 attempt ID + nonce를 한 번 반환
3. Client:
   - Google bridge를 해당 Web client ID + nonce로 configure
   - authorized account sign-in 시도
   - NoCredential이면 all-account/create-account 흐름
   - 사용자가 명시 버튼을 눌렀으면 explicit button flow 제공
4. Client -> Better Auth signIn.social:
   {
     provider: "google",
     idToken: { token, nonce },
     additionalData: { nativeAttemptId }
   }
5. Worker의 exact-route guard:
   - provider가 google인지 확인
   - idToken.token + idToken.nonce만 허용
   - accessToken/refreshToken/expiresAt/user 입력 거절
   - attempt ID + nonce digest + TTL + 미소비 상태를 한 SQL UPDATE로 소비
   - 실패 시 Better Auth handler에 전달하지 않음
6. Better Auth 1.6.23:
   - Google signature/iss/aud/exp/max-age/nonce 검증
   - Google sub를 accountId로 사용
   - D1 user/account/session 생성 또는 기존 account 조회
   - session Set-Cookie 반환
7. @better-auth/expo:
   - session cookie를 SecureStore에 저장
   - 이후 getCookie()를 인증 API 요청에 첨부
```

nonce를 client에서만 임의 생성해 ID token과 함께 보내는 방식은 token substitution 검출에는 도움이 되지만, 탈취된 `(token, nonce)` 쌍이 유효 기간 안에 반복 제출되는 것을 Better Auth 1.6.23 자체가 기억하지 못한다. `jti`는 Google token에서 선택적이며 Better Auth 1.6.23이 replay ledger로 사용하지 않는다. 그래서 서버 시도 레코드가 필요하다.

nonce는 Better Auth가 검증하기 전에 한 번 소비해도 된다. 공격자가 유효한 attempt ID/nonce를 알아내 invalid token으로 먼저 소비하면 해당 로그인 한 번이 실패할 수 있지만 새 attempt를 발급받아 재시도할 수 있고, 인증 우회는 되지 않는다. 이 구조는 Google JWT 검증을 별도로 복제하지 않고 Better Auth에 맡길 수 있어 더 작고 감사하기 쉽다.

Google의 ID-token 직접 로그인 요청은 browser CSRF cookie에 의존하지 않는다. HTTPS, 서버 발급 nonce, strict body schema, IP/attempt rate limit, no-store, token redaction을 적용한다.

### 3. Google Cloud client 구성

환경을 완전히 분리한다.

| 환경 | Google Cloud project | Android application ID | Web client | Android client |
| --- | --- | --- | --- | --- |
| Development | 별도 dev project | `com.example.app.dev` | dev backend audience | dev package + 실제 dev signing SHA-1 |
| Production | 별도 production project | `com.example.app` | production backend audience | production package + 배포물을 실제 서명하는 SHA-1 |

각 환경에서 Web client와 Android client는 같은 Google Cloud project에 둔다.

- Web OAuth client ID
  - Android `setServerClientId`/`webClientId`에 넣는다.
  - 해당 환경 Better Auth `google.clientId`와 정확히 같아야 한다.
  - ID token의 `aud`가 된다.
  - client ID는 공개 식별자이므로 앱 번들에 들어가도 된다.
  - native ID-token 전용 기준은 authorization-code exchange를 사용하지 않으므로 Google client secret을 만들거나 Worker에 저장하지 않는다.
- Android OAuth client
  - 앱의 정확한 application ID와 설치 APK/AAB를 실제 서명한 인증서 SHA-1을 등록한다.
  - Play 배포물은 Google Play App Signing 인증서 SHA-1이 핵심이다.
  - sideload EAS development/preview 빌드는 그 빌드의 실제 signing SHA-1을 dev project에 별도로 등록한다.
  - Android client ID를 앱의 `webClientId` 또는 Better Auth audience로 사용하지 않는다.

dev/prod 서버는 각자 하나의 Web client ID만 audience로 허용한다. Better Auth가 여러 client ID 배열을 받을 수 있어도, 한 호스트 앱 환경에 불필요한 audience를 추가하면 다른 환경 token을 받아들이는 범위만 넓어진다.

Credential Manager 직접 ID-token 흐름은 Google browser redirect URI를 사용하지 않는다. 새 흐름이 검증되고 기존 browser 경로가 닫힌 뒤 production Web client에서 과거 Worker callback URI를 제거할 수 있다. 이 작업은 콘솔 cutover 단계이며 코드 준비 작업과 분리한다.

### 4. Better Auth account/session 지속 경로

Better Auth 1.6.23의 실제 direct-ID-token 분기는 다음처럼 동작한다.

1. `idToken.token`과 선택적 `nonce`를 Google provider verifier에 전달한다.
2. 검증된 token claim에서 Google `sub`, email, name, picture를 얻는다.
3. `(providerId = "google", accountId = sub)`를 우선 조회한다.
4. account가 없으면 user와 account를 만들고, 있으면 해당 user를 사용한다.
5. 현재 설정의 `disableImplicitLinking: true` 때문에 같은 email만 일치하는 별도 subject는 자동 연결되지 않는다.
6. D1 session을 만들고 Better Auth session cookie를 반환한다.
7. `@better-auth/expo`가 cookie를 SecureStore에 저장한다. 앱 재시작 후 `get-session`/cache로 session을 복원한다.

이때 ID-token branch가 account persistence에 넘기는 provider token 필드는 caller가 선택적으로 보낸 `accessToken`뿐이다. Google ID token 원문은 검증과 profile 추출에 쓰이지만 account row의 `idToken`으로 넘겨지지 않는다. 따라서 client가 다음만 보내면 D1 provider token 컬럼은 null로 둘 수 있다.

```ts
idToken: {
  token: googleIdToken,
  nonce,
}
```

서버 정책을 명확히 하기 위해 다음을 권고한다.

- request guard에서 `idToken.accessToken`, `refreshToken`, `expiresAt`, caller-provided `user`를 거절한다.
- `account.storeAccountCookie: false`를 명시한다.
- `account.updateAccountOnSignIn: false`를 명시한다.
- `encryptOAuthTokens: true`는 다른 provider 또는 미래 기능을 위한 방어층으로 유지할 수 있다.
- D1 account token 컬럼은 Better Auth schema 호환을 위해 nullable 상태로 남겨도 된다. 테스트에서 Google direct sign-in 후 모두 null임을 확인한다.
- session cookie는 provider token이 아니라 이 서비스의 bearer session secret이다. SecureStore 보관, 로그 금지, TLS, 서버 revocation은 계속 필요하다.

주의: `react-native-nitro-google-signin` v2.0.0 자체는 Android Keystore로 암호화한 SharedPreferences에 최근 Google ID token을 저장해 `getCurrentUser()`를 지원한다. “provider token 미보관”은 서버 D1 미보관을 뜻하며, 기기의 단기 ID token까지 전혀 보관하지 않는다는 뜻은 아니다. sign-out 시 라이브러리 local state와 Better Auth session을 모두 지워야 한다.

### 5. Google provider token을 서버에 저장하지 않을 때의 계정 삭제

현재 Worker의 account deletion은 Better Auth `getAccessToken()`으로 provider access token을 얻고 Google revoke endpoint를 호출한다. direct ID-token 로그인에서 access/refresh token을 받지도 저장하지도 않으면 이 경로는 성공할 수 없다.

권고안은 로그인만 필요한 v1에서 Google API authorization scope와 offline access를 요청하지 않고 provider token도 저장하지 않는 것이다. breach impact와 token rotation/revocation 운영 부담이 줄어든다. 그 대신 다음 정책을 명시적으로 구현해야 한다.

- 로그아웃: Better Auth session revoke/sign-out + native `signOut()`/`clearCredentialState()`.
- 계정 삭제: 서버 D1의 user/account/session/sync data를 독립적으로 완전 삭제한다.
- Google grant disconnect: 지원할 경우 삭제 전에 client의 native `revokeAccess`를 best effort로 호출하고 결과를 표시한다. 실패해도 로컬 서비스 데이터 삭제를 막지 않는다.
- 서버 account-deletion 결과에서 “provider revoke 미확인”을 실제 의미대로 표현한다. provider token이 없는데 `getAccessToken()`을 호출하는 기존 구현을 그대로 두지 않는다.

Google API를 대신 호출해야 하는 실제 제품 요구가 생기기 전에는 `offlineAccess`, server auth code, access token, refresh token 저장을 추가하지 않는다.

## browser OAuth / custom-scheme handoff 제거 조건

첫 호스트 앱에 실제 사용자가 없다는 사실은 session/data migration을 단순하게 해 주지만, 공용 저장소의 다른 소비자를 자동으로 없애지는 않는다. 다음 조건을 모두 만족한 뒤 제거한다.

1. 호스트 앱의 production-signed Android build에서 다음이 실기기 검증됐다.
   - returning authorized account
   - new/unapproved account picker
   - explicit Google button fallback
   - 취소/네트워크 실패/Play Services 오류
   - nonce mismatch, expired attempt, consumed attempt, replay 거절
   - session restore, logout, account deletion
2. dev와 prod Google project 각각에 올바른 Web/Android client가 있고, package/SHA-1/audience가 교차되지 않는다.
3. Worker는 Google의 non-ID-token `/sign-in/social` 요청을 거절한다. UI에서 브라우저 버튼만 없애는 것으로는 부족하다. Better Auth 1.6.23의 같은 endpoint는 `idToken`이 없으면 여전히 authorization URL을 만든다.
4. Google direct sign-in과 명시적 account linking 모두 server-issued one-time nonce guard를 우회할 수 없다. linking UI가 없으면 link endpoint 자체를 닫는다.
5. provider-token 미보관에 맞는 account-deletion/revoke 정책이 구현·테스트됐다.
6. Kakao/Naver를 계속 지원한다면 각 provider의 native proof-to-server 경로가 별도로 완성됐다. 그렇지 않으면 provider를 이번 milestone에서 명시적으로 제거/보류한다. Google Credential Manager만으로 Kakao/Naver browser OAuth를 대체할 수 없다.
7. 다른 consumer가 handoff endpoint를 사용하지 않거나 함께 이전됐음을 확인한다. 이 조건이 확인되지 않으면 공용 platform에서 endpoint를 전역 삭제하는 것은 breaking change다.
8. Google 콘솔 callback 제거는 새 앱 출시 검증 후 마지막에 수행한다.

조건 충족 후 코드 정리 범위:

- Worker의 `/v1/mobile-auth/handoffs`, `/exchange`, `/cancel` route 및 callback response 변환 제거
- `mobile-auth-handoff.ts`, scheduled cleanup, 관련 API contract/schema/tests 제거
- Expo client의 `expo-web-browser` 로그인, PKCE handoff adapter, `expo-authorization-proxy` 의존 경로 제거
- Google browser callback용 trusted custom scheme/origin 제거
- Google browser sign-in을 열 수 있는 서버 route guard 추가
- `@better-auth/expo` client는 session cookie/SecureStore를 위해 유지
- server `expo()` plugin은 다른 browser provider가 사용하지 않을 때만 제거
- `expo-linking`, `expo-web-browser`, `expo-crypto`, generic OAuth client/plugin은 전체 workspace의 다른 사용처가 없음을 `rg`와 lockfile diff로 확인한 뒤 제거
- README/API/SECURITY/OPERATIONS/CONFIGURATION/PROVIDERS/ARCHITECTURE와 ADR 상태를 새 기준에 맞게 갱신

DB migration은 이미 공개 저장소와 배포 인스턴스에 적용된 이력이 있으므로 과거 `0004_mobile_auth_handoff.sql`을 몰래 수정하거나 번호를 재사용하지 않는다. 기존 D1을 유지한다면 forward-only migration으로 table을 drop한다. 모든 기존 D1 인스턴스를 명시적으로 폐기하고 새로 만들기로 결정한 경우에만 owner 승인 아래 migration baseline을 squash할 수 있다. 이번 조사에는 D1 변경 권한이 없다.

과거 ADR 0008/0009는 삭제보다 `Superseded`로 표시하고 새 native-ID-token ADR이 대체 이유를 기록하는 것이 보통 더 안전하다. “레거시 문서를 사용자 가이드에서 제거”와 “결정 이력을 Git history/ADR에서 지우기”는 같은 작업이 아니다.

## 현재 저장소와의 차이

현재 구현은 다음 legacy 경로를 실제로 포함한다.

- `apps/worker/src/mobile-auth-handoff.ts`
- `apps/worker/src/app.ts`의 세 handoff endpoint와 auth callback redirect 변환
- `apps/worker/migrations/0004_mobile_auth_handoff.sql`
- `packages/expo-client/src/secure-mobile-auth.ts`
- `packages/expo-client/src/index.ts`의 `expo-web-browser`, linking, PKCE verifier/challenge, authorization proxy
- 관련 API contract, tests, scheduled cleanup
- README, API, SECURITY, CONFIGURATION, OPERATIONS, PROVIDERS, ARCHITECTURE 및 ADR 0008/0009의 handoff 설명

현재 Better Auth 설정의 `disableImplicitLinking: true`, D1-backed session, cookie cache disabled, exact trusted origins, provider token encryption은 새 구조에서도 유효한 보안 기준이다. Google client ID는 단일 env 문자열이므로 각 deployment instance가 자기 환경의 Web client ID 하나만 받게 유지한다.

## 구현 및 검증 순서

1. 새 ADR에서 native ID-token + server nonce + no-provider-token 정책을 확정한다.
2. Better Auth 1.6.23 exact-source tests로 direct ID-token account/session/token-null 동작을 고정한다.
3. server nonce attempt schema/route/atomic consume/negative tests를 만든다.
4. Google browser sign-in bypass를 닫고 native direct sign-in만 허용한다.
5. native bridge를 좁은 Expo adapter에 추가하고 development build를 만든다.
6. dev Google project에서 debug/EAS development 서명 실기기 검증을 완료한다.
7. account deletion/revoke 정책을 no-provider-token 기준으로 바꾸고 검증한다.
8. 다른 provider/consumer 의존성을 확인한 뒤 handoff runtime과 사용자 문서를 제거한다.
9. applied migration은 forward-only로 정리한다.
10. production project의 Play-signed build로 최종 검증 후 Google callback URI와 legacy console client를 제거한다.

코드 품질 gate에는 최소한 typecheck, lint, 전체 unit/integration test, disposable D1 migration test, dependency audit, production preflight, Android development/release build를 포함한다.

## 불확실성 및 구현 blocker

### 출시 전 blocker

- 각 호스트 앱의 dev project, Web client ID, Android client(package/SHA-1)는 private deployment evidence에서 확인해야 한다.
- production project의 Web/Android client ID와 Play App Signing SHA-1도 public Platform Source에 기록하지 않는다.
- `react-native-nitro-google-signin` v2.0.0은 출시 이틀 차다. Expo 57/RN 0.86 production-signed Android 실기기 결과가 없다.
- `@better-auth/expo` 1.6.23은 peer range상 Expo 57을 허용하고 현재 workspace에서 typecheck 가능한 구조지만 package 자체 개발 기준은 더 오래된 Expo/RN이다. SecureStore cookie round trip을 SDK 57 실기기에서 재검증해야 한다.
- server-issued nonce ledger와 Google browser-path deny guard는 현재 구현돼 있으며, 변경 시 replay/browser bypass negative test를 유지해야 한다.
- provider token을 저장하지 않는 현재 기준에서는 account deletion과 native disconnect 결과를 분리해 유지한다.
- 다른 consumer가 legacy handoff를 계속 쓰는지 owner 수준 inventory가 필요하다. 확인 전 전역 삭제는 breaking change다.

### 별도 결정이 필요한 항목

- Better Auth 1.6.23을 전환 기간 동안 유지할지, 최신 1.7.1로 먼저/나중에 올릴지. 권고는 인증 구조 전환과 dependency major/minor 전환을 분리하는 것이다.
- Google native library v2.0.0을 즉시 채택할지, production 이력을 더 기다리거나 자체 standalone Expo Module을 택할지. 권고는 adapter 뒤에서 v2.0.0을 먼저 physical smoke-test하는 것이다.
- account deletion 시 Google grant disconnect를 client best-effort로 제공할지, “서비스 계정/데이터 삭제”와 “Google 연결 해제”를 분리해 안내할지.
- Kakao/Naver를 이번 greenfield baseline에서 제외할지, 각 provider native SDK/token verification을 별도 단계로 구현할지.

## 최종 판정

- 아키텍처 적합성: **조건부 승인**
- 권고 경로: **Credential Manager -> Google ID token -> Better Auth direct ID-token sign-in -> D1 session**
- legacy Google browser OAuth 유지 필요: **없음**, 단 위 제거 조건 충족 후
- provider token 서버 저장 필요: **로그인만 하는 v1에는 없음**
- 즉시 구현을 막는 핵심: **server one-time nonce, account deletion/revoke 재설계, 실제 Google clients/package/SHA-1, native library production smoke test, 다른 consumer/provider inventory**
