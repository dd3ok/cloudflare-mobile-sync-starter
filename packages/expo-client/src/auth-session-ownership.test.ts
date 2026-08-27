import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it } from "vitest";

import { ownedExpoClient } from "./auth-session-ownership";
import { createExpoAuthClient } from "./index";

const testStore = SecureStore as typeof SecureStore & {
  failNextSetItem(key: string): void;
  resetTestStore(): void;
};

const storagePrefix = "owned-session-test";
const cookieKey = `${storagePrefix}_cookie`;
const sessionCacheKey = `${storagePrefix}_session_data`;

function storedCookie(value: string): string {
  return JSON.stringify({
    "better-auth.session_token": {
      expires: null,
      value,
    },
  });
}

describe("Expo session ownership", () => {
  beforeEach(() => {
    testStore.resetTestStore();
  });

  it("atomically clears the local session only when the owned cookie is still current", () => {
    SecureStore.setItem(cookieKey, storedCookie("account-a"));
    SecureStore.setItem(sessionCacheKey, JSON.stringify({ user: { id: "account-a" } }));
    const authClient = createExpoAuthClient({
      baseUrl: "https://sync.example.test",
      scheme: "com.example.nativeapp.dev",
      storagePrefix,
    });

    expect(authClient.captureSessionOwnership()?.clear()).toBe(true);
    expect(authClient.getCookie()).toBe("");
    expect(SecureStore.getItem(sessionCacheKey)).toBe("{}");
  });

  it("preserves a replacement account when the owned cookie is stale", () => {
    SecureStore.setItem(cookieKey, storedCookie("account-b"));
    SecureStore.setItem(sessionCacheKey, JSON.stringify({ user: { id: "account-b" } }));
    const authClient = createExpoAuthClient({
      baseUrl: "https://sync.example.test",
      scheme: "com.example.nativeapp.dev",
      storagePrefix,
    });

    const ownership = authClient.captureSessionOwnership();
    expect(ownership).not.toBeNull();
    SecureStore.setItem(cookieKey, storedCookie("account-c"));

    expect(ownership?.clear()).toBe(false);
    expect(authClient.getCookie()).toBe("better-auth.session_token=account-c");
    expect(SecureStore.getItem(sessionCacheKey)).toBe(
      JSON.stringify({ user: { id: "account-b" } }),
    );
  });

  it("commits a prepared cookie only while the captured shared-session epoch is unchanged", () => {
    const authClient = createExpoAuthClient({
      baseUrl: "https://sync.example.test",
      scheme: "com.example.nativeapp.dev",
      storagePrefix,
    });
    const commit = authClient.prepareSessionCommit();

    expect(commit.install("better-auth.session_token=account-a; Path=/; HttpOnly; Secure")).toBe(
      true,
    );
    expect(authClient.getCookie()).toBe("better-auth.session_token=account-a");
  });

  it("does not let observer failures reverse an installed or cleared session", async () => {
    const plugin = ownedExpoClient({
      scheme: "com.example.nativeapp.dev",
      storage: SecureStore,
      storagePrefix,
    });
    const actions = plugin.getActions(
      {} as Parameters<typeof plugin.getActions>[0],
      {
        atoms: {
          session: {
            get: () => ({ data: null, error: null, isPending: false }),
            set: () => {
              throw new Error("subscriber failed");
            },
          },
        },
        notify: () => {
          throw new Error("signal subscriber failed");
        },
      } as unknown as Parameters<typeof plugin.getActions>[1],
    );

    expect(
      actions
        .prepareSessionCommit()
        .install("better-auth.session_token=account-a; Path=/; HttpOnly; Secure"),
    ).toBe(true);
    expect(actions.getCookie()).toBe("better-auth.session_token=account-a");
    await Promise.resolve();

    expect(actions.captureSessionOwnership()?.clear()).toBe(true);
    expect(actions.getCookie()).toBe("");
    await Promise.resolve();

    const fetchPlugin = plugin.fetchPlugins[0];
    const init = fetchPlugin?.init;
    const hooks = fetchPlugin?.hooks as
      | (NonNullable<typeof fetchPlugin>["hooks"] & {
          onRequest?(context: { signal: AbortSignal }): void | Promise<void>;
        })
      | undefined;
    const onRequest = hooks?.onRequest;
    const onSuccess = hooks?.onSuccess;
    if (!init || !onRequest || !onSuccess) throw new Error("Expo request hooks are unavailable");
    const applyResponse = async (url: string, setCookie: string) => {
      const initialized = await init(url, {});
      const request = {
        ...initialized.options,
        body: "",
        signal: new AbortController().signal,
        url: new URL(url),
      };
      await onRequest(request);
      await onSuccess({
        data: null,
        request,
        response: new Response(null, { headers: { "set-cookie": setCookie } }),
      } as unknown as Parameters<typeof onSuccess>[0]);
    };

    await applyResponse(
      "https://sync.example.test/v1/auth/get-session",
      "better-auth.session_token=account-b; Path=/; HttpOnly; Secure",
    );
    expect(actions.getCookie()).toBe("better-auth.session_token=account-b");
    await Promise.resolve();

    await applyResponse(
      "https://sync.example.test/v1/auth/sign-out",
      "better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; Secure",
    );
    expect(actions.getCookie()).toBe("");
    await Promise.resolve();
  });

  it("rejects shared-session ABA even when the final cookie equals the baseline", () => {
    SecureStore.setItem(cookieKey, storedCookie("account-a"));
    const authClient = createExpoAuthClient({
      baseUrl: "https://sync.example.test",
      scheme: "com.example.nativeapp.dev",
      storagePrefix,
    });
    const commit = authClient.prepareSessionCommit();

    expect(authClient.captureSessionOwnership()?.clear()).toBe(true);
    SecureStore.setItem(cookieKey, storedCookie("account-a"));

    expect(commit.install("better-auth.session_token=prepared; Path=/; HttpOnly; Secure")).toBe(
      false,
    );
    expect(authClient.getCookie()).toBe("better-auth.session_token=account-a");
  });

  it("rejects concurrent and delayed Better Auth responses from an older epoch", async () => {
    SecureStore.setItem(cookieKey, storedCookie("account-a"));
    const plugin = ownedExpoClient({
      scheme: "com.example.nativeapp.dev",
      storage: SecureStore,
      storagePrefix,
    });
    const session = {
      get: () => ({ data: null, error: null, isPending: false }),
      set: () => undefined,
    };
    const actions = plugin.getActions(
      {} as Parameters<typeof plugin.getActions>[0],
      {
        atoms: { session },
        notify: () => undefined,
      } as unknown as Parameters<typeof plugin.getActions>[1],
    );
    const fetchPlugin = plugin.fetchPlugins[0];
    const hooks = fetchPlugin?.hooks as
      | (NonNullable<typeof fetchPlugin>["hooks"] & {
          onRequest?(context: { signal: AbortSignal }): void | Promise<void>;
        })
      | undefined;
    const onSuccess = hooks?.onSuccess;
    const onRequest = hooks?.onRequest;
    const init = fetchPlugin?.init;
    if (!init || !onRequest || !onSuccess) throw new Error("Expo request hooks are unavailable");
    const requestUrl = "https://sync.example.test/v1/auth/callback";

    const initializedWithA = await init(requestUrl, {});
    expect(actions.captureSessionOwnership()?.clear()).toBe(true);
    const staleSignal = new AbortController().signal;
    expect(() => onRequest({ ...initializedWithA.options, signal: staleSignal })).toThrow(
      "shared session changed",
    );
    expect(
      actions
        .prepareSessionCommit()
        .install("better-auth.session_token=account-a; Path=/; HttpOnly; Secure"),
    ).toBe(true);
    const commit = actions.prepareSessionCommit();

    const context = async (value: string, signal = new AbortController().signal) => {
      const initialized = await init(requestUrl, {});
      const request = {
        ...initialized.options,
        body: "",
        signal,
        url: new URL(requestUrl),
      };
      await onRequest(request);
      return {
        data: null,
        request,
        response: new Response(null, {
          headers: {
            "set-cookie": `better-auth.session_token=${value}; Path=/; HttpOnly; Secure`,
          },
        }),
      } as unknown as Parameters<typeof onSuccess>[0];
    };

    const toBContext = await context("account-b");
    const backToAContext = await context("account-a");
    const toB = onSuccess(toBContext);
    const backToA = onSuccess(backToAContext);
    const rejectedBackToA = expect(backToA).rejects.toThrow("shared session changed");

    await toB;
    expect(commit.install("better-auth.session_token=prepared; Path=/; HttpOnly; Secure")).toBe(
      false,
    );
    await rejectedBackToA;
    expect(actions.getCookie()).toBe("better-auth.session_token=account-b");

    const reusedSignal = new AbortController().signal;
    const oldRequestWithReusedSignal = await context("account-a", reusedSignal);
    await onSuccess(await context("account-c"));
    const currentRequestWithReusedSignal = await context("account-c", reusedSignal);
    await expect(onSuccess(oldRequestWithReusedSignal)).rejects.toThrow("shared session changed");
    await onSuccess(currentRequestWithReusedSignal);
    expect(actions.getCookie()).toBe("better-auth.session_token=account-c");

    const delayed = await context("account-b");
    expect(actions.captureSessionOwnership()?.clear()).toBe(true);
    await expect(onSuccess(delayed)).rejects.toThrow("shared session changed");
    expect(actions.getCookie()).toBe("");

    expect(
      actions
        .prepareSessionCommit()
        .install("better-auth.session_token=account-a; Path=/; HttpOnly; Secure"),
    ).toBe(true);
    const midApplication = onSuccess(await context("x".repeat(2_000)));
    await Promise.resolve();
    expect(actions.captureSessionOwnership()?.clear()).toBe(true);
    await expect(midApplication).rejects.toThrow("shared session changed");
    expect(actions.getCookie()).toBe("");

    expect(
      actions
        .prepareSessionCommit()
        .install("better-auth.session_token=account-a; Path=/; HttpOnly; Secure"),
    ).toBe(true);
    testStore.failNextSetItem(`${cookieKey}.0.1`);
    await expect(onSuccess(await context("x".repeat(2_000)))).rejects.toThrow(
      "Injected SecureStore failure",
    );
    expect(actions.getCookie()).toBe("better-auth.session_token=account-a");
  });

  it("reads and commits Better Auth compatible chunked cookies", () => {
    const authClient = createExpoAuthClient({
      baseUrl: "https://sync.example.test",
      scheme: "com.example.nativeapp.dev",
      storagePrefix,
    });
    const preparedValue = "x".repeat(2_000);

    expect(
      authClient
        .prepareSessionCommit()
        .install(`better-auth.session_token=${preparedValue}; Path=/; HttpOnly; Secure`),
    ).toBe(true);
    expect(authClient.getCookie()).toBe(`better-auth.session_token=${preparedValue}`);
    expect(SecureStore.getItem(cookieKey)).toBe("\u0001cms-chunks:0:2");
  });

  it("preserves the previous cookie when a staged chunk write fails", () => {
    SecureStore.setItem(cookieKey, storedCookie("account-a"));
    const authClient = createExpoAuthClient({
      baseUrl: "https://sync.example.test",
      scheme: "com.example.nativeapp.dev",
      storagePrefix,
    });
    const commit = authClient.prepareSessionCommit();
    testStore.failNextSetItem(`${cookieKey}.0.1`);

    expect(() =>
      commit.install(`better-auth.session_token=${"x".repeat(2_000)}; Path=/; HttpOnly; Secure`),
    ).toThrow("Injected SecureStore failure");
    expect(authClient.getCookie()).toBe("better-auth.session_token=account-a");
  });
});
