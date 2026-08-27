import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { z } from "zod";
import type { Env } from "./env";
import { PublicError } from "./errors";
import { consumeGoogleAuthAttempt, createGoogleAuthAttempt } from "./native-google-auth";
import type { RequestPortalConfig } from "./request-portal-config";

const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const accessJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const googleProofSchema = z
  .object({
    attemptId: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/u),
    nonce: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/u),
    token: z.string().min(1).max(16_384),
  })
  .strict();

export type GoogleProof = z.infer<typeof googleProofSchema>;

export interface VerifiedGoogleIdentity {
  provider: "google";
  subject: string;
}

export interface AdminPrincipal {
  email: string;
}

export type VerifyGoogleIdentity = (
  proof: GoogleProof,
  env: Env,
  config: RequestPortalConfig,
) => Promise<VerifiedGoogleIdentity>;

export type VerifyTurnstile = (
  token: string,
  env: Env,
  config: RequestPortalConfig,
) => Promise<void>;

export type VerifyAdmin = (
  request: Request,
  env: Env,
  config: RequestPortalConfig,
) => Promise<AdminPrincipal>;

function invalidGoogleIdentity(): PublicError {
  return new PublicError(401, "UNAUTHORIZED", "Google verification failed");
}

export function parseGoogleProof(value: unknown): GoogleProof {
  const parsed = googleProofSchema.safeParse(value);
  if (!parsed.success) throw invalidGoogleIdentity();
  return parsed.data;
}

export function validateGoogleIdentityClaims(
  payload: JWTPayload,
  expectedAudience: string,
  expectedNonce: string,
  attemptCreatedAt: number,
  now: number,
): VerifiedGoogleIdentity {
  if (
    payload.aud !== expectedAudience ||
    (payload.azp !== undefined && payload.azp !== expectedAudience) ||
    payload.nonce !== expectedNonce ||
    typeof payload.sub !== "string" ||
    payload.sub.length < 1 ||
    payload.sub.length > 255 ||
    typeof payload.iat !== "number" ||
    payload.iat * 1_000 < attemptCreatedAt - 5_000 ||
    payload.iat * 1_000 > now + 5_000
  ) {
    throw invalidGoogleIdentity();
  }
  return { provider: "google", subject: payload.sub };
}

export async function createPortalGoogleChallenge(env: Env, config: RequestPortalConfig) {
  return await createGoogleAuthAttempt(env.DB, config.origin, env.GOOGLE_WEB_CLIENT_ID);
}

export const verifyGoogleIdentity: VerifyGoogleIdentity = async (proof, env, config) => {
  const parsed = parseGoogleProof(proof);
  const attempt = await consumeGoogleAuthAttempt(env.DB, config.origin, {
    attemptId: parsed.attemptId,
    nonce: parsed.nonce,
  });
  try {
    const { payload } = await jwtVerify(parsed.token, googleJwks, {
      algorithms: ["RS256"],
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: env.GOOGLE_WEB_CLIENT_ID,
      clockTolerance: 5,
      requiredClaims: ["sub", "iat", "exp", "nonce"],
    });
    return validateGoogleIdentityClaims(
      payload,
      env.GOOGLE_WEB_CLIENT_ID,
      parsed.nonce,
      attempt.createdAt,
      Date.now(),
    );
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw invalidGoogleIdentity();
  }
};

interface TurnstileResult {
  success?: boolean;
  hostname?: string;
  action?: string;
}

export const verifyTurnstile: VerifyTurnstile = async (token, _env, config) => {
  if (token.length < 1 || token.length > 2_048) {
    throw new PublicError(403, "FORBIDDEN", "Verification failed");
  }
  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: config.turnstileSecretKey, response: token }),
    });
  } catch {
    throw new PublicError(
      503,
      "PROVIDER_UNAVAILABLE",
      "Verification is temporarily unavailable",
      true,
    );
  }
  if (!response.ok) {
    throw new PublicError(
      503,
      "PROVIDER_UNAVAILABLE",
      "Verification is temporarily unavailable",
      true,
    );
  }
  let result: TurnstileResult;
  try {
    result = (await response.json()) as TurnstileResult;
  } catch {
    throw new PublicError(
      503,
      "PROVIDER_UNAVAILABLE",
      "Verification is temporarily unavailable",
      true,
    );
  }
  if (
    result.success !== true ||
    result.hostname !== new URL(config.origin).hostname ||
    result.action !== "request_case"
  ) {
    throw new PublicError(403, "FORBIDDEN", "Verification failed");
  }
};

export const verifyAdmin: VerifyAdmin = async (request, _env, config) => {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new PublicError(403, "FORBIDDEN", "Administrator access required");
  let jwks = accessJwks.get(config.accessTeamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${config.accessTeamDomain}/cdn-cgi/access/certs`));
    accessJwks.set(config.accessTeamDomain, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      issuer: config.accessTeamDomain,
      audience: config.accessAudience,
      clockTolerance: 5,
      requiredClaims: ["email", "iat", "nbf", "exp"],
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (payload.type !== "app" || !config.adminEmails.has(email)) {
      throw new Error("Access principal is not allowed");
    }
    return { email };
  } catch {
    throw new PublicError(403, "FORBIDDEN", "Administrator access required");
  }
};
