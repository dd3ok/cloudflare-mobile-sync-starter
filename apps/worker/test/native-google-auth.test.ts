import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

const APPLICATION_ID = env.NATIVE_APPLICATION_ID;

const app = createApp({
  async handleAuth(request) {
    const body = (await request.json()) as { provider?: string };
    return Response.json({ user: { id: "native-user" }, provider: body.provider });
  },
});

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(
    `https://sync.example.test${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function createAttempt() {
  const response = await post("/v1/native-auth/google/attempts", {
    applicationId: APPLICATION_ID,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    attemptId: string;
    nonce: string;
    webClientId: string;
    expiresAt: string;
  };
}

function signInBody(attempt: { attemptId: string; nonce: string }) {
  return {
    provider: "google",
    idToken: { token: "signed-google-id-token", nonce: attempt.nonce },
    additionalData: { nativeAttemptId: attempt.attemptId },
  };
}

describe("native Google authentication guard", () => {
  it("rate-limits public attempt issuance by the Cloudflare-provided client IP", async () => {
    const keys: string[] = [];
    const rateLimitedEnv = {
      ...env,
      AUTH_RATE_LIMITER: {
        async limit({ key }: { key: string }) {
          keys.push(key);
          return { success: false };
        },
      },
    };
    const response = await app.request(
      "https://sync.example.test/v1/native-auth/google/attempts",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.7",
          "content-type": "application/json",
        },
        body: JSON.stringify({ applicationId: APPLICATION_ID }),
      },
      rateLimitedEnv,
    );

    expect(response.status).toBe(429);
    expect(keys).toEqual(["203.0.113.7"]);
  });

  it("stores only a nonce digest and consumes an attempt exactly once", async () => {
    const attempt = await createAttempt();
    expect(attempt.webClientId).toBe(env.GOOGLE_WEB_CLIENT_ID);
    expect(attempt.attemptId).toMatch(/^[a-f0-9]{64}$/u);
    expect(attempt.nonce).toMatch(/^[a-f0-9]{64}$/u);

    const stored = await env.DB.prepare(
      `SELECT nonce_hash, consumed_at FROM native_google_auth_attempt WHERE id = ?`,
    )
      .bind(attempt.attemptId)
      .first<{ nonce_hash: string; consumed_at: number | null }>();
    expect(stored?.nonce_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored?.nonce_hash).not.toBe(attempt.nonce);
    expect(stored?.consumed_at).toBeNull();

    const accepted = await post("/v1/auth/sign-in/social", signInBody(attempt));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ user: { id: "native-user" }, provider: "google" });

    const replay = await post("/v1/auth/sign-in/social", signInBody(attempt));
    expect(replay.status).toBe(401);
  });

  it("atomically binds the attempt ID, nonce digest, application, TTL, and unused state", async () => {
    const first = await createAttempt();
    const second = await createAttempt();

    const mixedAttempt = await post("/v1/auth/sign-in/social", {
      ...signInBody(first),
      idToken: { token: "signed-google-id-token", nonce: second.nonce },
    });
    expect(mixedAttempt.status).toBe(401);

    const firstAfterMismatch = await env.DB.prepare(
      `SELECT consumed_at FROM native_google_auth_attempt WHERE id = ?`,
    )
      .bind(first.attemptId)
      .first<{ consumed_at: number | null }>();
    expect(firstAfterMismatch?.consumed_at).toBeNull();

    await env.DB.prepare(`UPDATE native_google_auth_attempt SET application_id = ? WHERE id = ?`)
      .bind("com.example.another", first.attemptId)
      .run();
    const wrongApplication = await post("/v1/auth/sign-in/social", signInBody(first));
    expect(wrongApplication.status).toBe(401);

    const firstAfterApplicationMismatch = await env.DB.prepare(
      `SELECT consumed_at FROM native_google_auth_attempt WHERE id = ?`,
    )
      .bind(first.attemptId)
      .first<{ consumed_at: number | null }>();
    expect(firstAfterApplicationMismatch?.consumed_at).toBeNull();
  });

  it("rejects wrong applications, browser OAuth, and provider token fields", async () => {
    const wrongApplication = await post("/v1/native-auth/google/attempts", {
      applicationId: "com.example.another",
    });
    expect(wrongApplication.status).toBe(403);

    const browser = await post("/v1/auth/sign-in/social", {
      provider: "google",
      callbackURL: "com.example.nativeapp.dev://auth/callback",
    });
    expect(browser.status).toBe(400);

    const attempt = await createAttempt();
    const providerToken = await post("/v1/auth/sign-in/social", {
      ...signInBody(attempt),
      idToken: {
        token: "signed-google-id-token",
        nonce: attempt.nonce,
        accessToken: "must-not-be-persisted",
      },
    });
    expect(providerToken.status).toBe(400);
  });

  it("rejects expired attempts and direct callback or linking routes", async () => {
    const attempt = await createAttempt();
    await env.DB.prepare(`UPDATE native_google_auth_attempt SET expires_at = ? WHERE id = ?`)
      .bind(Date.now() - 1, attempt.attemptId)
      .run();
    const expired = await post("/v1/auth/sign-in/social", signInBody(attempt));
    expect(expired.status).toBe(401);

    const callback = await app.request(
      "https://sync.example.test/v1/auth/callback/google",
      {},
      env,
    );
    expect(callback.status).toBe(404);
    const linking = await post("/v1/auth/link-social", {});
    expect(linking.status).toBe(404);
  });

  it("rejects normalized browser and linking path variants before Better Auth", async () => {
    let forwardedRequests = 0;
    const permissiveAuthApp = createApp({
      async handleAuth() {
        forwardedRequests += 1;
        return Response.json({ forwarded: true });
      },
    });
    const restrictedPaths = [
      "/v1/auth/sign-in/social/",
      "/v1/auth/callback/google/",
      "/v1/auth/callback//google",
      "/v1/auth/callback/%67oogle",
      "/v1/auth/link-social/",
    ];

    for (const path of restrictedPaths) {
      const response = await permissiveAuthApp.request(
        `https://sync.example.test${path}`,
        { method: "POST" },
        env,
      );
      expect(response.status, path).toBe(404);
    }
    expect(forwardedRequests).toBe(0);

    const session = await permissiveAuthApp.request(
      "https://sync.example.test/v1/auth/get-session",
      {},
      env,
    );
    expect(session.status).toBe(200);
    expect(forwardedRequests).toBe(1);
  });
});
