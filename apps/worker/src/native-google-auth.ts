import type {
  NativeGoogleAuthAttemptRequest,
  NativeGoogleAuthAttemptResponse,
  NativeGoogleSignInRequest,
} from "@cloudflare-mobile-sync/api-contract";
import { sha256Hex } from "./crypto";
import type { Env } from "./env";
import { PublicError } from "./errors";

const ATTEMPT_TTL_MILLISECONDS = 5 * 60 * 1_000;

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface GoogleAuthAttemptInput {
  attemptId: string;
  nonce: string;
}

export async function createGoogleAuthAttempt(
  db: D1Database,
  applicationId: string,
  webClientId: string,
): Promise<NativeGoogleAuthAttemptResponse> {
  const now = Date.now();
  const expiresAt = now + ATTEMPT_TTL_MILLISECONDS;
  const attemptId = randomHex(32);
  const nonce = randomHex(32);
  await pruneExpiredNativeGoogleAuthAttempts(db, now);
  await db
    .prepare(
      `INSERT INTO native_google_auth_attempt
         (id, application_id, nonce_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(attemptId, applicationId, await sha256Hex(nonce), now, expiresAt)
    .run();

  return {
    attemptId,
    nonce,
    webClientId,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function consumeGoogleAuthAttempt(
  db: D1Database,
  applicationId: string,
  request: GoogleAuthAttemptInput,
): Promise<{ createdAt: number }> {
  const now = Date.now();
  const consumed = await db
    .prepare(
      `UPDATE native_google_auth_attempt
       SET consumed_at = ?
       WHERE id = ? AND application_id = ? AND nonce_hash = ?
         AND consumed_at IS NULL AND expires_at > ?
       RETURNING id, created_at`,
    )
    .bind(now, request.attemptId, applicationId, await sha256Hex(request.nonce), now)
    .first<{ id: string; created_at: number }>();

  if (!consumed) {
    throw new PublicError(
      401,
      "UNAUTHORIZED",
      "Google authentication attempt is invalid or expired",
    );
  }
  return { createdAt: consumed.created_at };
}

export async function pruneExpiredNativeGoogleAuthAttempts(
  db: D1Database,
  now: number,
): Promise<void> {
  await db.prepare(`DELETE FROM native_google_auth_attempt WHERE expires_at <= ?`).bind(now).run();
}

export async function createNativeGoogleAuthAttempt(
  env: Pick<Env, "DB" | "GOOGLE_WEB_CLIENT_ID" | "NATIVE_APPLICATION_ID">,
  request: NativeGoogleAuthAttemptRequest,
): Promise<NativeGoogleAuthAttemptResponse> {
  if (request.applicationId !== env.NATIVE_APPLICATION_ID) {
    throw new PublicError(403, "FORBIDDEN", "Native application is not allowed");
  }

  return await createGoogleAuthAttempt(env.DB, request.applicationId, env.GOOGLE_WEB_CLIENT_ID);
}

export async function consumeNativeGoogleAuthAttempt(
  env: Pick<Env, "DB" | "NATIVE_APPLICATION_ID">,
  request: NativeGoogleSignInRequest,
): Promise<void> {
  await consumeGoogleAuthAttempt(env.DB, env.NATIVE_APPLICATION_ID, {
    attemptId: request.additionalData.nativeAttemptId,
    nonce: request.idToken.nonce,
  });
}
