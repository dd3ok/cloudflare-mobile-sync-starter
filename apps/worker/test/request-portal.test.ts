import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { PublicError } from "../src/errors";
import { consumeGoogleAuthAttempt } from "../src/native-google-auth";
import { rejectRequestEmail } from "../src/request-email";
import { createPortalGoogleChallenge, validateGoogleIdentityClaims } from "../src/request-identity";
import { requestPortalConfig } from "../src/request-portal-config";

function portalEnv() {
  return {
    ...env,
    REQUEST_PORTAL_ENABLED: "true",
    REQUEST_PORTAL_ORIGIN: "https://requests.portal.test",
    REQUEST_PORTAL_ORGANIZATION_NAME: "Unit Studio",
    REQUEST_PORTAL_PRODUCT_NAME: "Unit App",
    REQUEST_PORTAL_PUBLIC_SCOPE: "organization",
    REQUEST_PORTAL_ACCOUNT_SCOPE: "unit-app",
    REQUEST_PORTAL_NOTICE_VERSION: "1.0",
    REQUEST_EVIDENCE_POLICY_VERSION: "test-policy-1",
    REQUEST_PORTAL_PENDING_MAX_AGE_DAYS: "30",
    REQUEST_PORTAL_IDENTITY_ISSUE_ENABLED: "true",
    REQUEST_PORTAL_ACCOUNT_DELETION_ENABLED: "true",
    REQUEST_DB_GENERATION: "test-generation-1",
    REQUEST_PORTAL_TURNSTILE_SITE_KEY: "unit-site-key",
    REQUEST_PORTAL_TURNSTILE_SECRET_KEY: "unit-test-only-turnstile-secret-0123456789",
    REQUEST_PORTAL_ACCESS_TEAM_DOMAIN: "https://unit.cloudflareaccess.com",
    REQUEST_PORTAL_ACCESS_AUDIENCE: "test-audience",
    REQUEST_PORTAL_ADMIN_EMAILS: "admin@unit.test",
    REQUEST_SUBJECT_HMAC_KEY: "unit-test-only-request-subject-key-0123456789",
  };
}

async function request(
  app: ReturnType<typeof createApp>,
  path: string,
  options: RequestInit = {},
  origin = "https://requests.portal.test",
) {
  return await app.request(`${origin}${path}`, options, portalEnv());
}

describe("request portal edge", () => {
  it("accepts real-size deployment identifiers and rejects committed example values", () => {
    const configured = requestPortalConfig({
      ...portalEnv(),
      REQUEST_PORTAL_ACCESS_AUDIENCE: "a".repeat(64),
      REQUEST_DB_GENERATION: "4d9f4b84-b5ce-46fe-8d22-8bea83d7717d",
    });
    expect(configured.accessAudience).toHaveLength(64);
    expect(configured.requestDbGeneration).toHaveLength(36);
    expect(configured.pendingMaxAgeMilliseconds).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(() =>
      requestPortalConfig({
        ...portalEnv(),
        REQUEST_PORTAL_ORIGIN: "https://requests.example.com",
      }),
    ).toThrow("example value");
    expect(() =>
      requestPortalConfig({
        ...portalEnv(),
        REQUEST_PORTAL_PENDING_MAX_AGE_DAYS: "0",
      }),
    ).toThrow("between 1 and 365 days");
  });

  it("is disabled by default and cannot be reached through another Worker hostname", async () => {
    const app = createApp();
    const disabled = await app.request("https://requests.portal.test/", {}, env);
    expect(disabled.status).toBe(404);

    const wrongHost = await request(app, "/", {}, "https://sync.portal.test");
    expect(wrongHost.status).toBe(404);
  });

  it("serves paired pages with a nonce CSP and removes receipt fragments before lookup", async () => {
    const app = createApp();
    const korean = await request(app, "/");
    const english = await request(app, "/en/");
    const html = await korean.text();

    expect(korean.status).toBe(200);
    expect(english.status).toBe(200);
    const contentSecurityPolicy = korean.headers.get("content-security-policy");
    expect(contentSecurityPolicy).toContain("script-src 'nonce-");
    expect(contentSecurityPolicy).toContain("https://challenges.cloudflare.com");
    expect(contentSecurityPolicy).not.toContain(
      "https://challenges.cloudflare.com/turnstile/v0/api.js",
    );
    expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(html).toContain("history.replaceState");
    expect(html).toContain("request_case");
    expect(await english.text()).toContain("Requests and account deletion");
  });

  it("requires exact same-origin POSTs and verifies Turnstile before storing", async () => {
    const turnstile = vi.fn(async () => undefined);
    const app = createApp({ requestPortal: { verifyTurnstile: turnstile } });
    const body = JSON.stringify({
      kind: "inquiry",
      locale: "en",
      noticeVersion: "1.0",
      requestText: "plain text",
      turnstileToken: "test-token",
    });
    const crossOrigin = await request(app, "/api/cases", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.test" },
      body,
    });
    expect(crossOrigin.status).toBe(403);
    expect(turnstile).not.toHaveBeenCalled();

    const accepted = await request(app, "/api/cases", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://requests.portal.test",
      },
      body,
    });
    expect(accepted.status).toBe(201);
    expect(turnstile).toHaveBeenCalledOnce();
    const result = (await accepted.json()) as { receipt: string };
    expect(result.receipt).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/u);
    expect(
      JSON.stringify(await env.REQUEST_DB.prepare("SELECT * FROM request_case").first()),
    ).not.toContain(result.receipt);
  });

  it("verifies Turnstile before rejecting a stale notice without storing", async () => {
    const turnstile = vi.fn(async () => undefined);
    const app = createApp({ requestPortal: { verifyTurnstile: turnstile } });
    const counts = async () =>
      await env.REQUEST_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM request_case) AS case_count,
           (SELECT COUNT(*) FROM request_evidence) AS evidence_count`,
      ).first<{ case_count: number; evidence_count: number }>();
    const before = await counts();

    const rejected = await request(app, "/api/cases", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://requests.portal.test",
      },
      body: JSON.stringify({
        kind: "inquiry",
        locale: "en",
        noticeVersion: "stale-probe",
        requestText: "non-storing verification probe",
        turnstileToken: "test-token",
      }),
    });

    expect(rejected.status).toBe(400);
    expect(turnstile).toHaveBeenCalledOnce();
    expect(await counts()).toEqual(before);
  });

  it("keeps the administrator route closed without an accepted Access principal", async () => {
    const app = createApp({
      requestPortal: {
        verifyAdmin: async () => {
          throw new PublicError(403, "FORBIDDEN", "Administrator access required");
        },
      },
    });
    const response = await request(app, "/admin/");
    expect(response.status).toBe(403);

    const allowed = createApp({
      requestPortal: {
        verifyAdmin: async () => ({ email: "admin@unit.test" }),
      },
    });
    expect((await request(allowed, "/admin/")).status).toBe(200);
  });

  it("issues a portal-scoped, one-time Google challenge", async () => {
    const requestEnv = portalEnv();
    const config = requestPortalConfig(requestEnv);
    const challenge = await createPortalGoogleChallenge(requestEnv, config);
    await expect(
      consumeGoogleAuthAttempt(requestEnv.DB, config.origin, {
        attemptId: challenge.attemptId,
        nonce: challenge.nonce,
      }),
    ).resolves.toMatchObject({ createdAt: expect.any(Number) });
    await expect(
      consumeGoogleAuthAttempt(requestEnv.DB, config.origin, {
        attemptId: challenge.attemptId,
        nonce: challenge.nonce,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects mismatched Google audience, nonce, and issuance time claims", () => {
    const now = Date.now();
    const claims = {
      aud: "google-client.apps.googleusercontent.com",
      azp: "google-client.apps.googleusercontent.com",
      nonce: "expected-nonce",
      sub: "google-subject",
      iat: Math.floor(now / 1_000),
    };
    expect(
      validateGoogleIdentityClaims(
        claims,
        "google-client.apps.googleusercontent.com",
        "expected-nonce",
        now - 1_000,
        now,
      ),
    ).toEqual({ provider: "google", subject: "google-subject" });
    expect(() =>
      validateGoogleIdentityClaims(
        { ...claims, aud: "attacker" },
        "google-client.apps.googleusercontent.com",
        "expected-nonce",
        now - 1_000,
        now,
      ),
    ).toThrow("Google verification failed");
    expect(() =>
      validateGoogleIdentityClaims(
        { ...claims, nonce: "replayed" },
        "google-client.apps.googleusercontent.com",
        "expected-nonce",
        now - 1_000,
        now,
      ),
    ).toThrow("Google verification failed");
    expect(() =>
      validateGoogleIdentityClaims(
        { ...claims, iat: Math.floor((now - 60_000) / 1_000) },
        "google-client.apps.googleusercontent.com",
        "expected-nonce",
        now - 1_000,
        now,
      ),
    ).toThrow("Google verification failed");
  });

  it("rejects inbound email without reading sender, subject, headers, or body", () => {
    const setReject = vi.fn();
    rejectRequestEmail({ setReject }, portalEnv());
    expect(setReject).toHaveBeenCalledWith(
      "Email is not accepted. Use the request portal at https://requests.portal.test.",
    );
  });
});
