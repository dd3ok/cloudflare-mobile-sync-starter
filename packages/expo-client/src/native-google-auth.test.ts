import { describe, expect, it, vi } from "vitest";

import { createNativeGoogleAuth, type NativeGoogleCredentialProvider } from "./native-google-auth";

const attempt = {
  attemptId: "a".repeat(64),
  nonce: "b".repeat(64),
  webClientId: "123456789-example.apps.googleusercontent.com",
  expiresAt: "2026-08-19T12:05:00.000Z",
};

function sessionCommit(current = true) {
  return {
    prepareSessionCommit: vi.fn(() => ({
      install: vi.fn(() => true),
      isCurrent: vi.fn(() => current),
    })),
  };
}

describe("native Google authentication", () => {
  it("forwards cancellation to the first network request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException("Aborted", "AbortError");
    });
    const nativeAuth = createNativeGoogleAuth({
      applicationId: "com.example.nativeapp.dev",
      authClient: sessionCommit(),
      baseUrl: "https://sync.example.test",
      credentialProvider: {
        signIn: vi.fn(async () => ({ idToken: "unused" })),
        clearCredentialState: vi.fn(async () => undefined),
      },
      fetch,
      scheme: "com.example.nativeapp.dev",
    });

    await expect(nativeAuth.signIn(controller.signal)).rejects.toThrow("Aborted");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects an invalid attempt response before opening the account picker", async () => {
    const credentialProvider: NativeGoogleCredentialProvider = {
      signIn: vi.fn(async () => ({ idToken: "unused" })),
      clearCredentialState: vi.fn(async () => undefined),
    };
    const nativeAuth = createNativeGoogleAuth({
      applicationId: "com.example.nativeapp.dev",
      authClient: sessionCommit(),
      baseUrl: "https://sync.example.test",
      credentialProvider,
      fetch: vi.fn(async () => Response.json({ ...attempt, nonce: "client-chosen" })),
      scheme: "com.example.nativeapp.dev",
    });

    await expect(nativeAuth.signIn()).rejects.toThrow();
    expect(credentialProvider.signIn).not.toHaveBeenCalled();
  });

  it("clears native credential state when the server rejects the ID token", async () => {
    const clearCredentialState = vi.fn(async () => undefined);
    let requests = 0;
    const nativeAuth = createNativeGoogleAuth({
      applicationId: "com.example.nativeapp.dev",
      authClient: sessionCommit(),
      baseUrl: "https://sync.example.test",
      credentialProvider: {
        signIn: vi.fn(async () => ({ idToken: "signed-google-id-token" })),
        clearCredentialState,
      },
      fetch: vi.fn(async () => {
        requests += 1;
        return requests === 1
          ? Response.json(attempt, { status: 201 })
          : Response.json({ message: "nonce already consumed" }, { status: 401 });
      }),
      scheme: "com.example.nativeapp.dev",
    });

    await expect(nativeAuth.signIn()).rejects.toThrow("nonce already consumed");
    expect(clearCredentialState).toHaveBeenCalledOnce();
  });

  it("does not clear replacement-account native state after a rejected ID token", async () => {
    const clearCredentialState = vi.fn(async () => undefined);
    let requests = 0;
    const nativeAuth = createNativeGoogleAuth({
      applicationId: "com.example.nativeapp.dev",
      authClient: sessionCommit(false),
      baseUrl: "https://sync.example.test",
      credentialProvider: {
        signIn: vi.fn(async () => ({ idToken: "signed-google-id-token" })),
        clearCredentialState,
      },
      fetch: vi.fn(async () => {
        requests += 1;
        return requests === 1
          ? Response.json(attempt, { status: 201 })
          : Response.json({ message: "nonce already consumed" }, { status: 401 });
      }),
      scheme: "com.example.nativeapp.dev",
    });

    await expect(nativeAuth.signIn()).rejects.toThrow("nonce already consumed");
    expect(clearCredentialState).not.toHaveBeenCalled();
  });

  it("treats provider disconnect as best effort", async () => {
    const unsupported = createNativeGoogleAuth({
      applicationId: "com.example.nativeapp.dev",
      authClient: sessionCommit(),
      baseUrl: "https://sync.example.test",
      credentialProvider: {
        signIn: vi.fn(),
        clearCredentialState: vi.fn(async () => undefined),
      },
      scheme: "com.example.nativeapp.dev",
    });
    await expect(unsupported.revokeAccess()).resolves.toBe("unsupported");

    const failed = createNativeGoogleAuth({
      applicationId: "com.example.nativeapp.dev",
      authClient: sessionCommit(),
      baseUrl: "https://sync.example.test",
      credentialProvider: {
        signIn: vi.fn(),
        clearCredentialState: vi.fn(async () => undefined),
        revokeAccess: vi.fn(async () => {
          throw new Error("provider unavailable");
        }),
      },
      scheme: "com.example.nativeapp.dev",
    });
    await expect(failed.revokeAccess()).resolves.toBe("failed");
  });
});
