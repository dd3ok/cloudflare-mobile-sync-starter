import { afterEach, describe, expect, it, vi } from "vitest";

import { createExpoAuthClient } from "./index";

describe("createExpoAuthClient origin contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends only the standard Origin after the Expo and Better Auth hooks run", async () => {
    let sentHeaders: Headers | undefined;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      sentHeaders = new Request(input, init).headers;
      return Response.json({ status: true });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("unexpected global fetch"))),
    );
    const authClient = createExpoAuthClient({
      baseUrl: "https://sync.example.test",
      fetch,
      scheme: "com.example.nativeapp.dev",
      storagePrefix: "unit-origin-contract",
    });

    const result = await authClient.revokeSession({ token: "unit-session-reference" });

    expect(result.error).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(sentHeaders?.get("origin")).toBe("com.example.nativeapp.dev://");
    expect(sentHeaders?.has("expo-origin")).toBe(false);
  });
});
