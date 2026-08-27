import { describe, expect, it, vi } from "vitest";

import { createNativeGoogleAuth } from "./native-google-auth";

const attempt = {
  attemptId: "a".repeat(64),
  nonce: "b".repeat(64),
  webClientId: "123456789-example.apps.googleusercontent.com",
  expiresAt: "2026-08-19T12:05:00.000Z",
};

function fixture(input?: {
  authPath?: string;
  baselineCurrent?: boolean;
  installResult?: boolean;
  signInContentType?: string;
  signInPayload?: unknown;
  signInStatus?: number;
}) {
  const install = vi.fn(() => input?.installResult ?? true);
  const isCurrent = vi.fn(() => input?.baselineCurrent ?? true);
  const prepareSessionCommit = vi.fn(() => ({ install, isCurrent }));
  const clearCredentialState = vi.fn(async () => undefined);
  const fetch = vi.fn(async (request: string | URL | Request, _init?: RequestInit) => {
    const url = String(request);
    if (url.endsWith("/v1/native-auth/google/attempts")) {
      return Response.json(attempt, { status: 201 });
    }
    if (url.endsWith("/sign-in/social")) {
      return new Response(
        JSON.stringify(
          input?.signInPayload ?? {
            redirect: false,
            token: "prepared-session-token",
            user: { id: "account-a", email: "a@example.test" },
          },
        ),
        {
          status: input?.signInStatus ?? 200,
          headers: {
            "Content-Type": input?.signInContentType ?? "application/json",
            "Set-Cookie":
              "better-auth.session_token=prepared-session-cookie; Path=/; HttpOnly; Secure",
          },
        },
      );
    }
    if (url.endsWith("/get-session")) {
      return Response.json({
        session: { token: "prepared-session-token" },
        user: { id: "account-a" },
      });
    }
    return Response.json({ status: true });
  });
  const value = createNativeGoogleAuth({
    applicationId: "com.example.nativeapp.dev",
    authClient: { prepareSessionCommit },
    ...(input?.authPath === undefined ? {} : { authPath: input.authPath }),
    baseUrl: "https://sync.example.test",
    credentialProvider: {
      signIn: vi.fn(async () => ({ idToken: "signed-google-id-token" })),
      clearCredentialState,
    },
    fetch,
    scheme: "com.example.nativeapp.dev",
  });
  return {
    clearCredentialState,
    fetch,
    install,
    isCurrent,
    prepareSessionCommit,
    value,
  };
}

describe("prepared native Google sign-in", () => {
  it("keeps the new session private until a synchronous commit", async () => {
    const subject = fixture();

    const prepared = await subject.value.signIn();

    expect(prepared.user).toEqual({ id: "account-a" });
    expect(subject.prepareSessionCommit).toHaveBeenCalledOnce();
    expect(subject.install).not.toHaveBeenCalled();
    const [signInUrl, signInInit] = subject.fetch.mock.calls[1] ?? [];
    expect(signInUrl).toBe("https://sync.example.test/v1/auth/sign-in/social");
    expect(new Headers(signInInit?.headers).get("origin")).toBe("com.example.nativeapp.dev://");
    expect(new Headers(signInInit?.headers).has("cookie")).toBe(false);
    expect(signInInit?.credentials).toBe("omit");
    expect(signInInit?.redirect).toBe("manual");
    expect(JSON.parse(String(signInInit?.body))).toEqual({
      provider: "google",
      idToken: { token: "signed-google-id-token", nonce: attempt.nonce },
      additionalData: { nativeAttemptId: attempt.attemptId },
    });

    prepared.session.commit();
    expect(subject.install).toHaveBeenCalledWith(
      "better-auth.session_token=prepared-session-cookie; Path=/; HttpOnly; Secure",
    );
  });

  it("rejects commit when the shared session changed and can still abort only the prepared session", async () => {
    const subject = fixture({ baselineCurrent: false, installResult: false });
    const prepared = await subject.value.signIn();

    expect(() => prepared.session.commit()).toThrow("shared session changed");
    await prepared.session.abort();

    const [revokeUrl, revokeInit] = subject.fetch.mock.calls.at(-1) ?? [];
    expect(revokeUrl).toBe("https://sync.example.test/v1/auth/revoke-session");
    expect(new Headers(revokeInit?.headers).get("cookie")).toBe(
      "better-auth.session_token=prepared-session-cookie",
    );
    expect(revokeInit?.body).toBe(JSON.stringify({ token: "prepared-session-token" }));
    expect(subject.clearCredentialState).not.toHaveBeenCalled();
  });

  it("clears native credential state after abort only while the baseline is still current", async () => {
    const subject = fixture({ baselineCurrent: true });
    const prepared = await subject.value.signIn();

    await prepared.session.abort();

    expect(subject.clearCredentialState).toHaveBeenCalledOnce();
  });

  it("makes abort idempotent and forbids abort after commit", async () => {
    const aborted = fixture();
    const abortedSession = (await aborted.value.signIn()).session;
    await abortedSession.abort();
    await abortedSession.abort();
    expect(
      aborted.fetch.mock.calls.filter(([url]) => String(url).endsWith("/revoke-session")),
    ).toHaveLength(1);

    const committed = fixture();
    const committedSession = (await committed.value.signIn()).session;
    committedSession.commit();
    await expect(committedSession.abort()).rejects.toThrow("already committed");
  });

  it("revokes a server-created session when its success payload cannot establish ownership", async () => {
    const subject = fixture({
      signInPayload: {
        redirect: false,
        token: "prepared-session-token",
        user: { email: "missing-id@example.test" },
      },
    });

    await expect(subject.value.signIn()).rejects.toThrow(
      "session ownership could not be established",
    );

    const [revokeUrl, revokeInit] = subject.fetch.mock.calls.at(-1) ?? [];
    expect(revokeUrl).toBe("https://sync.example.test/v1/auth/revoke-session");
    expect(new Headers(revokeInit?.headers).get("cookie")).toBe(
      "better-auth.session_token=prepared-session-cookie",
    );
    expect(revokeInit?.body).toBe(JSON.stringify({ token: "prepared-session-token" }));
    expect(subject.clearCredentialState).toHaveBeenCalledOnce();
  });

  it("inspects and revokes a session when its success response cannot be decoded", async () => {
    const subject = fixture({ signInContentType: "text/plain" });

    await expect(subject.value.signIn()).rejects.toThrow("invalid response");

    expect(subject.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://sync.example.test/v1/native-auth/google/attempts",
      "https://sync.example.test/v1/auth/sign-in/social",
      "https://sync.example.test/v1/auth/get-session",
      "https://sync.example.test/v1/auth/revoke-session",
    ]);
    expect(subject.clearCredentialState).toHaveBeenCalledOnce();
  });

  it("inspects and revokes a session returned with a redirect response", async () => {
    const subject = fixture({ signInStatus: 302 });

    await expect(subject.value.signIn()).rejects.toThrow("Native Google sign-in failed");

    const [, signInInit] = subject.fetch.mock.calls[1] ?? [];
    expect(signInInit?.redirect).toBe("manual");
    expect(subject.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://sync.example.test/v1/native-auth/google/attempts",
      "https://sync.example.test/v1/auth/sign-in/social",
      "https://sync.example.test/v1/auth/get-session",
      "https://sync.example.test/v1/auth/revoke-session",
    ]);
    expect(subject.clearCredentialState).toHaveBeenCalledOnce();
  });

  it("uses the configured Better Auth path for sign-in and exact-session abort", async () => {
    const subject = fixture({ authPath: "/custom/auth" });
    const prepared = await subject.value.signIn();

    expect(String(subject.fetch.mock.calls[1]?.[0])).toBe(
      "https://sync.example.test/custom/auth/sign-in/social",
    );
    await prepared.session.abort();
    expect(String(subject.fetch.mock.calls.at(-1)?.[0])).toBe(
      "https://sync.example.test/custom/auth/revoke-session",
    );
  });
});
