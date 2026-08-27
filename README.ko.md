# Cloudflare Mobile Sync

[English](./README.md) | 한국어

모바일 앱을 위한 자가 호스팅 인증·증분 동기화 플랫폼입니다. 호스트 앱마다
Cloudflare Worker와 D1 데이터베이스를 독립적으로 배포합니다. 이 저장소는
공개 소스이며 여러 앱이 함께 쓰는 호스팅 서비스가 아닙니다.

## 확정 기준

- Android Credential Manager가 Google ID 토큰을 발급받습니다.
- Worker가 5분짜리 일회용 nonce를 발급하고 D1에서 원자적으로 소비합니다.
- Better Auth 1.6.23이 Google 토큰을 검증하고 D1 세션을 만듭니다.
- 앱은 Better Auth 세션 쿠키만 Expo SecureStore에 보관합니다.
- Google access/refresh/ID token은 D1에 저장하지 않습니다.
- 브라우저 OAuth, Worker callback, private-scheme handoff, Google client
  secret, Kakao, Naver는 활성 기준에서 제외했습니다.
- 동기화는 local-first이며 사용자별 범위와 요청 크기를 엄격히 제한합니다.

`react-native-nitro-google-signin` 2.0.0은 좁은 어댑터 뒤에 고정했습니다.
실제 제품 출시는 production 서명 실기기 검증을 통과한 뒤에만 승인합니다.

## 저장소 구조

```text
apps/worker               Cloudflare Worker와 D1 migration
packages/api-contract     이식 가능한 런타임 스키마와 타입
packages/client-core      플랫폼 중립 동기화 로직
packages/expo-client      Expo 세션과 네이티브 Google 어댑터 경계
examples/expo-app         Android Credential Manager 예제
docs                      아키텍처·보안·운영·ADR
```

제품별 Worker 이름, D1 ID, 도메인, Google Cloud 프로젝트, Android application
ID, 출시 증거는 이 공개 저장소에 두지 않습니다. 별도 비공개 deployment
저장소에서 이 소스의 정확한 commit과 migration hash를 고정해 관리합니다.

## 로컬 검사

Node.js 22.13–24와 pnpm 11.9.0이 필요합니다.

```bash
pnpm install
pnpm --filter @cloudflare-mobile-sync/worker migrate:local
pnpm --filter @cloudflare-mobile-sync/worker dev
pnpm check
```

`apps/worker/.dev.vars.example`을 무시되는 `.dev.vars`로 복사하고 Better Auth
secret 예시값을 교체하세요. 커밋된 Wrangler 파일은 비운영 예제입니다. 이
파일로 원격 migration이나 배포를 실행하면 안 됩니다.

네이티브 Google 로그인은 Expo development build가 필요합니다. Expo Go와
웹 미리보기에서는 Credential Manager를 검증할 수 없습니다. 실기기 검사
전 같은 Google Cloud 프로젝트에 Web client와 package/SHA-1 기반 Android
client를 만들고 `GOOGLE_WEB_CLIENT_ID`, `NATIVE_APPLICATION_ID` 공개 변수를
환경별 deployment 설정에 넣습니다.

세부 내용은 [아키텍처](./docs/ARCHITECTURE.md),
[설정](./docs/CONFIGURATION.md), [API](./docs/API.md),
[Google 설정](./docs/PROVIDERS.md), [보안](./docs/SECURITY.md),
[운영](./docs/OPERATIONS.md), [ADR 0014](./docs/adr/0014-native-google-id-token-authentication.md)를 참고하세요.

## 의도적으로 제외한 범위

Firebase, CRDT, 멀티테넌트 SaaS, 실시간 구독 서비스가 아닙니다. 현재 인증
기준은 Android Google 로그인뿐입니다. iOS, 다른 제공자, Google API scope,
offline access, refresh token, 자동 계정 연결은 별도 검토 후 추가합니다.

## 라이선스

소스 코드는 [MIT 라이선스](./LICENSE)로 제공합니다. 공개 패키지 배포를
별도로 승인하기 전까지 워크스페이스 패키지는 `private: true`를 유지합니다.
