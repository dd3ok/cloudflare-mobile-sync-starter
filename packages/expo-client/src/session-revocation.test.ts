import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExpoAuthClient } from "./index";
import { clearExpoSessionForSubject, revokeExpoSession } from "./session-revocation";

const testStore = SecureStore as typeof SecureStore & { resetTestStore(): void };
const storagePrefix = "session-revocation-test";
const cookieKey = `${storagePrefix}_cookie`;

function storedCookie(value: string): string {
  return JSON.stringify({
    "better-auth.session_token": { expires: null, value },
  });
}

function fixture(input?: {
  session?: null | { session: { token: string }; user: { id: string } };
  revokeStatus?: number;
}) {
  SecureStore.setItem(cookieKey, storedCookie("session-a"));
  const authClient = createExpoAuthClient({
    baseUrl: "https://sync.example.test",
    scheme: "com.example.nativeapp.dev",
    storagePrefix,
  });
  const calls: string[] = [];
  const fetch = vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (url.endsWith("/get-session")) {
      calls.push("read");
      return Response.json(
        input?.session === undefined
          ? { session: { token: "token-a" }, user: { id: "account-a" } }
          : input.session,
      );
    }
    calls.push("revoke");
    return Response.json(input?.revokeStatus === undefined ? { status: true } : { status: false }, {
      status: input?.revokeStatus ?? 200,
    });
  });
  return {
    authClient,
    calls,
    options: {
      authClient,
      baseUrl: "https://sync.example.test",
      fetch,
      scheme: "com.example.nativeapp.dev",
    },
  };
}

describe("revokeExpoSession", () => {
  beforeEach(() => testStore.resetTestStore());

  it("revokes the captured authoritative session before clearing it locally", async () => {
    const subject = fixture();

    await expect(
      revokeExpoSession(subject.options, () => {
        subject.calls.push("host-clear");
      }),
    ).resolves.toBe(true);

    expect(subject.calls).toEqual(["read", "revoke", "host-clear"]);
    expect(subject.authClient.getCookie()).toBe("");
  });

  it("clears a stale local cookie after a definitive null response", async () => {
    const subject = fixture({ session: null });

    await expect(revokeExpoSession(subject.options)).resolves.toBe(true);
    expect(subject.calls).toEqual(["read"]);
    expect(subject.authClient.getCookie()).toBe("");
  });

  it("preserves a replacement session installed during the authoritative read", async () => {
    const subject = fixture();
    subject.options.fetch = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.endsWith("/get-session")) {
        const current = subject.authClient.captureSessionOwnership();
        expect(current?.clear()).toBe(true);
        expect(
          subject.authClient
            .prepareSessionCommit()
            .install("better-auth.session_token=session-b; Path=/; HttpOnly; Secure"),
        ).toBe(true);
        return Response.json({ session: { token: "token-a" }, user: { id: "account-a" } });
      }
      return Response.json({ status: true });
    });

    await expect(revokeExpoSession(subject.options)).resolves.toBe(false);
    expect(subject.authClient.getCookie()).toBe("better-auth.session_token=session-b");
  });

  it("does not clear locally when authoritative revocation fails", async () => {
    const subject = fixture({ revokeStatus: 500 });

    await expect(revokeExpoSession(subject.options)).rejects.toThrow(
      "authoritative session could not be revoked",
    );
    expect(subject.authClient.getCookie()).toBe("better-auth.session_token=session-a");
  });

  it("uses a configured auth path for raw session requests", async () => {
    const subject = fixture({ session: null });
    await revokeExpoSession({ ...subject.options, authPath: "/custom/auth" });

    expect(subject.options.fetch).toHaveBeenCalledWith(
      "https://sync.example.test/custom/auth/get-session",
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
  });
});

describe("clearExpoSessionForSubject", () => {
  beforeEach(() => testStore.resetTestStore());

  it("preserves an authenticated replacement subject", async () => {
    const subject = fixture({
      session: { session: { token: "token-b" }, user: { id: "account-b" } },
    });

    await expect(clearExpoSessionForSubject(subject.options, "account-a")).resolves.toBe(false);
    expect(subject.authClient.getCookie()).toBe("better-auth.session_token=session-a");
  });

  it("clears the expected or definitively stale subject", async () => {
    const expected = fixture();
    await expect(clearExpoSessionForSubject(expected.options, "account-a")).resolves.toBe(true);
    expect(expected.authClient.getCookie()).toBe("");

    testStore.resetTestStore();
    const stale = fixture({ session: null });
    await expect(clearExpoSessionForSubject(stale.options, "account-a")).resolves.toBe(true);
    expect(stale.authClient.getCookie()).toBe("");
  });
});
