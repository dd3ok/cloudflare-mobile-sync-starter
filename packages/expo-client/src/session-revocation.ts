import type { ExpoSessionOwnership } from "./auth-session-ownership";
import { readOwnedSessionCookie } from "./auth-session-ownership";
import { fetchBoundedJsonWithTimeout } from "./fetch-with-timeout";
import { validateMobileScheme } from "./mobile-scheme";

interface AuthoritativeSession {
  session: { token: string };
  user: { id: string };
}

export interface ExpoSessionRevocationClient {
  captureSessionOwnership(): ExpoSessionOwnership | null;
}

export interface ExpoSessionRevocationOptions {
  authClient: ExpoSessionRevocationClient;
  authPath?: string;
  baseUrl: string;
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

function requestTimeout(options: ExpoSessionRevocationOptions): number {
  const value = options.requestTimeoutMilliseconds ?? 15_000;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("requestTimeoutMilliseconds must be positive");
  }
  return value;
}

async function readAuthoritativeSession(
  options: ExpoSessionRevocationOptions,
  ownership: ExpoSessionOwnership,
): Promise<AuthoritativeSession | null> {
  const { payload, response } = await fetchBoundedJsonWithTimeout(
    options.fetch ?? globalThis.fetch,
    `${options.baseUrl.replace(/\/$/u, "")}${normalizeAuthPath(options.authPath)}/get-session`,
    {
      headers: {
        Cookie: readOwnedSessionCookie(ownership),
        Origin: `${options.scheme}://`,
      },
      credentials: "omit",
      redirect: "error",
    },
    requestTimeout(options),
    "The authoritative session could not be read",
  );
  if (!response.ok) throw new Error("The authoritative session could not be read");
  if (payload === null) return null;
  if (typeof payload !== "object" || payload === null) {
    throw new Error("The authoritative session could not be read");
  }
  const session = "session" in payload ? payload.session : null;
  const user = "user" in payload ? payload.user : null;
  const token =
    typeof session === "object" && session !== null && "token" in session
      ? session.token
      : undefined;
  const subjectId = typeof user === "object" && user !== null && "id" in user ? user.id : undefined;
  if (typeof token !== "string" || token.length === 0 || typeof subjectId !== "string") {
    throw new Error("The authoritative session could not be read");
  }
  return { session: { token }, user: { id: subjectId } };
}

async function revokeAuthoritativeSession(
  options: ExpoSessionRevocationOptions,
  ownership: ExpoSessionOwnership,
  token: string,
): Promise<void> {
  const { payload, response } = await fetchBoundedJsonWithTimeout(
    options.fetch ?? globalThis.fetch,
    `${options.baseUrl.replace(/\/$/u, "")}${normalizeAuthPath(options.authPath)}/revoke-session`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: readOwnedSessionCookie(ownership),
        Origin: `${options.scheme}://`,
      },
      body: JSON.stringify({ token }),
      credentials: "omit",
      redirect: "error",
    },
    requestTimeout(options),
    "The authoritative session could not be revoked",
  );
  if (
    !response.ok ||
    typeof payload !== "object" ||
    payload === null ||
    !("status" in payload) ||
    payload.status !== true
  ) {
    throw new Error("The authoritative session could not be revoked");
  }
}

async function clearOwnedSession(
  ownership: ExpoSessionOwnership,
  onCleared?: () => void | Promise<void>,
): Promise<boolean> {
  const cleared = ownership.clear();
  if (cleared) await onCleared?.();
  return cleared;
}

/**
 * Reads and revokes with the captured cookie directly, avoiding Better Auth
 * plugin side effects on the shared local cookie before ownership is checked.
 */
export async function revokeExpoSession(
  options: ExpoSessionRevocationOptions,
  onCleared?: () => void | Promise<void>,
): Promise<boolean> {
  validateMobileScheme(options.scheme);
  const ownership = options.authClient.captureSessionOwnership();
  if (ownership === null) throw new Error("The authoritative session could not be read");

  const current = await readAuthoritativeSession(options, ownership);
  if (current === null) return clearOwnedSession(ownership, onCleared);
  await revokeAuthoritativeSession(options, ownership, current.session.token);
  return clearOwnedSession(ownership, onCleared);
}

/**
 * Clears only a deleted subject's captured session. A replacement subject is
 * identified by the same side-effect-free authoritative read and preserved.
 */
export async function clearExpoSessionForSubject(
  options: ExpoSessionRevocationOptions,
  expectedSubjectId: string,
  onCleared?: () => void | Promise<void>,
): Promise<boolean> {
  validateMobileScheme(options.scheme);
  const ownership = options.authClient.captureSessionOwnership();
  if (ownership === null) {
    await onCleared?.();
    return true;
  }

  const current = await readAuthoritativeSession(options, ownership);
  if (current !== null && current.user.id !== expectedSubjectId) return false;
  return clearOwnedSession(ownership, onCleared);
}
