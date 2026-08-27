import { getCookie, getSetCookie } from "@better-auth/expo/client";
import {
  type NativeGoogleAuthAttemptResponse,
  nativeGoogleAuthAttemptResponseSchema,
} from "@cloudflare-mobile-sync/api-contract";
import type { CancellationSignal } from "@cloudflare-mobile-sync/client-core";
import { BoundedJsonResponseError, fetchBoundedJsonWithTimeout } from "./fetch-with-timeout";
import { validateMobileScheme } from "./mobile-scheme";

export interface NativeGoogleCredentialProvider {
  signIn(input: { webClientId: string; nonce: string }): Promise<{ idToken: string }>;
  clearCredentialState(): Promise<void>;
  revokeAccess?(): Promise<void>;
}

export interface NativeGooglePreparedSession {
  abort(): Promise<void>;
  commit(): void;
}

export interface NativeGoogleUser {
  id: string;
}

export interface NativeGoogleSignInResult {
  user: NativeGoogleUser;
  session: NativeGooglePreparedSession;
}

export interface NativeGoogleAuth {
  signIn(signal?: CancellationSignal): Promise<NativeGoogleSignInResult>;
  clearCredentialState(): Promise<void>;
  revokeAccess(): Promise<"requested" | "unsupported" | "failed">;
}

interface NativeGoogleAuthClient {
  prepareSessionCommit(): {
    install(setCookieHeader: string): boolean;
    isCurrent(): boolean;
  };
}

async function revokeOwnedNativeSession(
  options: NativeGoogleAuthOptions,
  baseUrl: string,
  fetchImplementation: typeof globalThis.fetch,
  sessionCommit: ReturnType<NativeGoogleAuthClient["prepareSessionCommit"]>,
  token: string,
  cookie: string,
): Promise<void> {
  const { payload, response } = await fetchBoundedJsonWithTimeout(
    fetchImplementation,
    `${baseUrl}${normalizeAuthPath(options.authPath)}/revoke-session`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: `${options.scheme}://`,
      },
      body: JSON.stringify({ token }),
      credentials: "omit",
      redirect: "error",
    },
    requestTimeout(options.requestTimeoutMilliseconds),
    "The owned native session could not be revoked",
  );
  if (
    !response.ok ||
    typeof payload !== "object" ||
    payload === null ||
    !("status" in payload) ||
    payload.status !== true
  ) {
    throw new Error("The owned native session could not be revoked");
  }

  if (sessionCommit.isCurrent()) {
    await options.credentialProvider.clearCredentialState().catch(() => undefined);
  }
}

export interface NativeGoogleAuthOptions {
  applicationId: string;
  authClient: NativeGoogleAuthClient;
  authPath?: string;
  baseUrl: string;
  credentialProvider: NativeGoogleCredentialProvider;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMilliseconds?: number;
  scheme: string;
}

function normalizeAuthPath(authPath: string | undefined): string {
  const value = (authPath ?? "/v1/auth").trim();
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new Error("authPath must be an absolute URL path");
  }
  return value.replace(/\/+$/u, "");
}

function requestTimeout(value: number | undefined): number {
  const timeout = value ?? 15_000;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("requestTimeoutMilliseconds must be positive");
  }
  return timeout;
}

function readAttempt(response: Response, payload: unknown): NativeGoogleAuthAttemptResponse {
  if (!response.ok) {
    throw new Error("Native Google authentication attempt could not be created");
  }
  return nativeGoogleAuthAttemptResponseSchema.parse(payload);
}

async function readOwnedSessionToken(
  options: NativeGoogleAuthOptions,
  baseUrl: string,
  authPath: string,
  fetchImplementation: typeof globalThis.fetch,
  cookie: string,
): Promise<string | null> {
  const { payload, response } = await fetchBoundedJsonWithTimeout(
    fetchImplementation,
    `${baseUrl}${authPath}/get-session`,
    {
      headers: { Cookie: cookie, Origin: `${options.scheme}://` },
      credentials: "omit",
      redirect: "error",
    },
    requestTimeout(options.requestTimeoutMilliseconds),
    "The malformed native session could not be inspected",
  );
  if (!response.ok) throw new Error("The malformed native session could not be inspected");
  if (payload === null) return null;
  const session =
    typeof payload === "object" && payload !== null && "session" in payload
      ? payload.session
      : null;
  const token =
    typeof session === "object" && session !== null && "token" in session
      ? session.token
      : undefined;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("The malformed native session could not be inspected");
  }
  return token.trim();
}

async function rejectMalformedNativeSignIn(
  options: NativeGoogleAuthOptions,
  baseUrl: string,
  authPath: string,
  fetchImplementation: typeof globalThis.fetch,
  sessionCommit: ReturnType<NativeGoogleAuthClient["prepareSessionCommit"]>,
  response: Response | undefined,
  primaryError: unknown,
): Promise<never> {
  const setCookieHeader = response?.headers.get("set-cookie")?.trim() ?? "";
  const cookie = setCookieHeader ? getCookie(getSetCookie(setCookieHeader)).trim() : "";
  try {
    if (cookie) {
      const token = await readOwnedSessionToken(
        options,
        baseUrl,
        authPath,
        fetchImplementation,
        cookie,
      );
      if (token) {
        await revokeOwnedNativeSession(
          options,
          baseUrl,
          fetchImplementation,
          sessionCommit,
          token,
          cookie,
        );
      } else if (sessionCommit.isCurrent()) {
        await options.credentialProvider.clearCredentialState();
      }
    } else if (sessionCommit.isCurrent()) {
      await options.credentialProvider.clearCredentialState();
    }
  } catch (cleanupError) {
    const aggregate = new AggregateError(
      [primaryError, cleanupError],
      primaryError instanceof Error ? primaryError.message : "Native Google sign-in failed",
    );
    Object.defineProperty(aggregate, "cause", { value: primaryError });
    throw aggregate;
  }
  throw primaryError;
}

function createPreparedSession(
  options: NativeGoogleAuthOptions,
  baseUrl: string,
  fetchImplementation: typeof globalThis.fetch,
  sessionCommit: ReturnType<NativeGoogleAuthClient["prepareSessionCommit"]>,
  setCookieHeader: string,
  token: string,
  cookie: string,
): NativeGooglePreparedSession {
  let state: "prepared" | "aborting" | "aborted" | "committed" = "prepared";
  let pending: Promise<void> | null = null;

  return {
    commit() {
      if (state === "committed") {
        throw new Error("The prepared native session is already committed");
      }
      if (state !== "prepared") {
        throw new Error("The prepared native session cannot be committed");
      }
      if (!sessionCommit.install(setCookieHeader)) {
        throw new Error("The shared session changed before sign-in commit");
      }
      state = "committed";
    },
    abort() {
      if (state === "committed") {
        return Promise.reject(new Error("The prepared native session is already committed"));
      }
      if (state === "aborted") return Promise.resolve();
      if (pending) return pending;
      state = "aborting";

      const task = revokeOwnedNativeSession(
        options,
        baseUrl,
        fetchImplementation,
        sessionCommit,
        token,
        cookie,
      );

      pending = task.then(
        () => {
          state = "aborted";
        },
        (error: unknown) => {
          pending = null;
          state = "prepared";
          throw error;
        },
      );
      return pending;
    },
  };
}

export function createNativeGoogleAuth(options: NativeGoogleAuthOptions): NativeGoogleAuth {
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMilliseconds = requestTimeout(options.requestTimeoutMilliseconds);
  const authPath = normalizeAuthPath(options.authPath);
  validateMobileScheme(options.scheme);

  return {
    async signIn(signal) {
      const sessionCommit = options.authClient.prepareSessionCommit();
      const attemptResult = await fetchBoundedJsonWithTimeout(
        fetchImplementation,
        `${baseUrl}/v1/native-auth/google/attempts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ applicationId: options.applicationId }),
          credentials: "omit",
          redirect: "error",
        },
        timeoutMilliseconds,
        "Native Google authentication attempt could not be created",
        signal,
      );
      const attempt = readAttempt(attemptResult.response, attemptResult.payload);
      const credential = await options.credentialProvider.signIn({
        webClientId: attempt.webClientId,
        nonce: attempt.nonce,
      });
      let response: Response;
      let payload: unknown;
      try {
        const result = await fetchBoundedJsonWithTimeout(
          fetchImplementation,
          `${baseUrl}${authPath}/sign-in/social`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: `${options.scheme}://`,
              "X-Skip-OAuth-Proxy": "true",
            },
            body: JSON.stringify({
              provider: "google",
              idToken: { token: credential.idToken, nonce: attempt.nonce },
              additionalData: { nativeAttemptId: attempt.attemptId },
            }),
            credentials: "omit",
            redirect: "manual",
          },
          timeoutMilliseconds,
          "Native Google sign-in returned an invalid response",
          signal,
        );
        response = result.response;
        payload = result.payload;
      } catch (error) {
        return rejectMalformedNativeSignIn(
          options,
          baseUrl,
          authPath,
          fetchImplementation,
          sessionCommit,
          error instanceof BoundedJsonResponseError ? error.response : undefined,
          error,
        );
      }

      const data = typeof payload === "object" && payload !== null ? payload : null;
      const rawUser = data && "user" in data ? data.user : null;
      const userId =
        typeof rawUser === "object" && rawUser !== null && "id" in rawUser ? rawUser.id : undefined;
      const token =
        data && "token" in data && typeof data.token === "string" ? data.token.trim() : "";
      const setCookieHeader = response.headers.get("set-cookie")?.trim() ?? "";
      const cookie = getCookie(getSetCookie(setCookieHeader)).trim();
      const errorMessage =
        data && "message" in data && typeof data.message === "string" ? data.message : undefined;
      if (!response.ok) {
        return rejectMalformedNativeSignIn(
          options,
          baseUrl,
          authPath,
          fetchImplementation,
          sessionCommit,
          response,
          new Error(errorMessage ?? "Native Google sign-in failed"),
        );
      }
      if (typeof userId !== "string" || !userId || token.length === 0 || cookie.length === 0) {
        const ownershipError = new Error(
          "Native Google session ownership could not be established",
        );
        return rejectMalformedNativeSignIn(
          options,
          baseUrl,
          authPath,
          fetchImplementation,
          sessionCommit,
          response,
          ownershipError,
        );
      }
      return {
        user: { id: userId },
        session: createPreparedSession(
          options,
          baseUrl,
          fetchImplementation,
          sessionCommit,
          setCookieHeader,
          token,
          cookie,
        ),
      };
    },
    clearCredentialState() {
      return options.credentialProvider.clearCredentialState();
    },
    async revokeAccess() {
      if (!options.credentialProvider.revokeAccess) return "unsupported";
      try {
        await options.credentialProvider.revokeAccess();
        return "requested";
      } catch {
        return "failed";
      }
    },
  };
}
