import {
  API_VERSION,
  accountDeletionOperationIdSchema,
  accountDeletionStatusRequestSchema,
  LIMITS,
  nativeGoogleAuthAttemptRequestSchema,
  nativeGoogleSignInRequestSchema,
  pullQuerySchema,
  pushRequestSchema,
  retainedTombstoneRequestSchema,
} from "@cloudflare-mobile-sync/api-contract";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type AuthenticatedUser,
  deleteAccountData,
  getAccount,
  readAccountDeletionReceipt,
} from "./account";
import { createAuth } from "./auth";
import { commaSeparated, type Env } from "./env";
import { errorEnvelope, PublicError } from "./errors";
import {
  consumeNativeGoogleAuthAttempt,
  createNativeGoogleAuthAttempt,
} from "./native-google-auth";
import { createRequestPortalApp, type RequestPortalDependencies } from "./request-portal";
import { retainTombstone } from "./retained-tombstone";
import { pullChanges, pushMutations } from "./sync-repository";

type Variables = { requestId: string; user: AuthenticatedUser };
type Authenticate = (request: Request, env: Env) => Promise<AuthenticatedUser | null>;
type HandleAuth = (request: Request, env: Env) => Promise<Response>;

export interface AppDependencies {
  authenticate?: Authenticate;
  handleAuth?: HandleAuth;
  requestPortal?: RequestPortalDependencies;
}

function isRestrictedAuthFallback(path: string): boolean {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return true;
  }
  const normalizedPath = decodedPath.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "");
  return (
    normalizedPath === "/v1/auth/sign-in/social" ||
    normalizedPath === "/v1/auth/link-social" ||
    normalizedPath.startsWith("/v1/auth/callback/")
  );
}

async function defaultAuthenticate(request: Request, env: Env): Promise<AuthenticatedUser | null> {
  const result = await createAuth(env).api.getSession({ headers: request.headers });
  if (!result) return null;
  return {
    id: result.user.id,
    name: result.user.name,
    email: result.user.email,
    image: result.user.image ?? null,
    sessionCreatedAt: result.session.createdAt,
  };
}

interface BodyReadableRequest {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

async function parseBody(request: BodyReadableRequest): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > LIMITS.requestBodyBytes) {
    throw new PublicError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let receivedBytes = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > LIMITS.requestBodyBytes) {
          await reader.cancel().catch(() => undefined);
          throw new PublicError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
        }
        parts.push(decoder.decode(chunk.value, { stream: true }));
      }
      parts.push(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  }
  const text = parts.join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new PublicError(400, "VALIDATION_ERROR", "Request body must be valid JSON");
  }
}

function allowedCollections(env: Env): ReadonlySet<string> {
  return new Set(commaSeparated(env.ALLOWED_COLLECTIONS));
}

async function consumeRateLimit(
  limiter: RateLimit,
  key: string,
  units: number,
  message: string,
): Promise<void> {
  for (let unit = 0; unit < units; unit += 1) {
    const result = await limiter.limit({ key });
    if (!result.success) throw new PublicError(429, "RATE_LIMITED", message, true);
  }
}

export function createApp(dependencies: AppDependencies = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  const forwardAuthRequest: HandleAuth = async (request, env) =>
    dependencies.handleAuth
      ? await dependencies.handleAuth(request, env)
      : await createAuth(env).handler(request);
  const authenticate = dependencies.authenticate ?? defaultAuthenticate;

  app.use("*", async (context, next) => {
    const cloudflareRay = context.req.header("cf-ray")?.trim();
    const requestId =
      cloudflareRay && /^[A-Za-z0-9-]{1,64}$/u.test(cloudflareRay)
        ? cloudflareRay
        : crypto.randomUUID();
    context.set("requestId", requestId);
    try {
      await next();
    } finally {
      context.header("Cache-Control", "no-store");
      context.header("Referrer-Policy", "no-referrer");
      context.header("X-Content-Type-Options", "nosniff");
      context.header("X-Request-ID", requestId);
      if (!context.res.headers.has("Content-Security-Policy")) {
        context.header(
          "Content-Security-Policy",
          "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        );
      }
    }
  });

  app.get("/health", async (context) => {
    await context.env.DB.prepare("SELECT 1").first();
    return context.json({ ok: true, version: API_VERSION } as const);
  });

  app.use("/v1/auth/*", async (context, next) => {
    const clientIp = context.req.header("cf-connecting-ip")?.trim() || "unknown";
    await consumeRateLimit(
      context.env.AUTH_RATE_LIMITER,
      clientIp,
      1,
      "Too many authentication requests",
    );
    await next();
  });
  app.post("/v1/auth/sign-in/social", async (context) => {
    const parsed = nativeGoogleSignInRequestSchema.safeParse(
      await parseBody(context.req.raw.clone()),
    );
    if (!parsed.success) {
      throw new PublicError(
        400,
        "VALIDATION_ERROR",
        "Only native Google ID-token sign-in is supported",
      );
    }
    await consumeNativeGoogleAuthAttempt(context.env, parsed.data);
    return await forwardAuthRequest(context.req.raw, context.env);
  });
  app.all("/v1/auth/sign-in/social", () => {
    throw new PublicError(405, "NOT_FOUND", "Route not found");
  });
  app.all("/v1/auth/callback/google", () => {
    throw new PublicError(404, "NOT_FOUND", "Browser Google OAuth is not supported");
  });
  app.all("/v1/auth/link-social", () => {
    throw new PublicError(404, "NOT_FOUND", "Provider account linking is not supported");
  });
  app.all("/v1/auth/*", async (context) => {
    if (isRestrictedAuthFallback(context.req.path)) {
      throw new PublicError(404, "NOT_FOUND", "Route not found");
    }
    return await forwardAuthRequest(context.req.raw, context.env);
  });

  app.post("/v1/native-auth/google/attempts", async (context) => {
    const clientIp = context.req.header("cf-connecting-ip")?.trim() || "unknown";
    await consumeRateLimit(
      context.env.AUTH_RATE_LIMITER,
      clientIp,
      1,
      "Too many authentication requests",
    );
    const parsed = nativeGoogleAuthAttemptRequestSchema.safeParse(await parseBody(context.req.raw));
    if (!parsed.success) {
      throw new PublicError(400, "VALIDATION_ERROR", "Invalid native authentication request");
    }
    return context.json(await createNativeGoogleAuthAttempt(context.env, parsed.data), 201);
  });

  app.post("/v1/account-deletions/status", async (context) => {
    const clientIp = context.req.header("cf-connecting-ip")?.trim() || "unknown";
    await consumeRateLimit(
      context.env.AUTH_RATE_LIMITER,
      `account-deletion-status:${clientIp}`,
      1,
      "Too many account deletion status requests",
    );
    const parsed = accountDeletionStatusRequestSchema.safeParse(await parseBody(context.req.raw));
    if (!parsed.success) {
      throw new PublicError(400, "VALIDATION_ERROR", "Invalid account deletion status request");
    }
    const receipt = await readAccountDeletionReceipt(context.env.DB, parsed.data);
    if (!receipt) {
      throw new PublicError(404, "NOT_FOUND", "Account deletion receipt was not found");
    }
    return context.json(receipt);
  });

  app.use("/v1/sync/*", async (context, next) => {
    const user = await authenticate(context.req.raw, context.env);
    if (!user) throw new PublicError(401, "UNAUTHORIZED", "Authentication required");
    context.set("user", user);
    await next();
  });
  app.use("/v1/account", async (context, next) => {
    const user = await authenticate(context.req.raw, context.env);
    if (!user) throw new PublicError(401, "UNAUTHORIZED", "Authentication required");
    context.set("user", user);
    await next();
  });

  app.post("/v1/sync/push", async (context) => {
    const user = context.get("user");
    const parsed = pushRequestSchema.safeParse(await parseBody(context.req.raw));
    if (!parsed.success) {
      throw new PublicError(400, "VALIDATION_ERROR", "Invalid sync mutation request");
    }
    const allowed = allowedCollections(context.env);
    if (parsed.data.mutations.some((mutation) => !allowed.has(mutation.collection))) {
      throw new PublicError(403, "FORBIDDEN", "Collection is not allowed");
    }
    await consumeRateLimit(
      context.env.SYNC_RATE_LIMITER,
      `push:${user.id}`,
      parsed.data.mutations.length,
      "Too many sync writes",
    );

    const results = await pushMutations(context.env.DB, user.id, parsed.data.mutations);
    return context.json({ results });
  });

  app.post("/v1/sync/retained-tombstone", async (context) => {
    const user = context.get("user");
    const parsed = retainedTombstoneRequestSchema.safeParse(await parseBody(context.req.raw));
    if (!parsed.success) {
      throw new PublicError(400, "VALIDATION_ERROR", "Invalid retained tombstone request");
    }
    await consumeRateLimit(
      context.env.SYNC_RATE_LIMITER,
      `retained-tombstone:${user.id}`,
      1,
      "Too many sync writes",
    );
    return context.json(await retainTombstone(context.env, user.id, parsed.data));
  });

  app.get("/v1/sync/pull", async (context) => {
    const parsed = pullQuerySchema.safeParse({
      cursor: context.req.query("cursor"),
      limit: context.req.query("limit"),
      collection: context.req.query("collection"),
    });
    if (!parsed.success) {
      throw new PublicError(400, "VALIDATION_ERROR", "Invalid pull query");
    }
    if (
      parsed.data.collection !== undefined &&
      !allowedCollections(context.env).has(parsed.data.collection)
    ) {
      throw new PublicError(403, "FORBIDDEN", "Collection is not allowed");
    }
    await consumeRateLimit(
      context.env.SYNC_RATE_LIMITER,
      `pull:${context.get("user").id}`,
      1,
      "Too many sync reads",
    );
    return context.json(
      await pullChanges(
        context.env.DB,
        context.get("user").id,
        parsed.data.cursor,
        parsed.data.limit,
        parsed.data.collection,
      ),
    );
  });

  app.get("/v1/account", async (context) =>
    context.json(await getAccount(context.env.DB, context.get("user"))),
  );

  app.delete("/v1/account", async (context) => {
    const user = context.get("user");
    const expectedSubject = context.req.header("x-mobile-sync-expected-subject");
    if (!expectedSubject || expectedSubject !== user.id) {
      throw new PublicError(409, "CONFLICT", "Account changed before the destructive request");
    }
    const operationId = context.req.header("x-mobile-sync-deletion-operation")?.trim();
    if (!accountDeletionOperationIdSchema.safeParse(operationId).success) {
      throw new PublicError(400, "VALIDATION_ERROR", "Account deletion operation ID is required");
    }
    const receiptInput = { operationId: operationId as string, expectedSubjectId: user.id };
    if (Date.now() - user.sessionCreatedAt.getTime() > 24 * 60 * 60 * 1_000) {
      throw new PublicError(401, "UNAUTHORIZED", "A fresh login is required");
    }
    const outcome = await deleteAccountData(context.env.DB, user.id, receiptInput);
    if (outcome.providerRevocationFailures.length > 0) {
      console.info("Account deleted; provider disconnect remains client-managed", {
        providers: outcome.providerRevocationFailures,
        requestId: context.get("requestId"),
      });
    }
    const receipt = await readAccountDeletionReceipt(context.env.DB, receiptInput);
    if (!receipt) throw new Error("Account deletion receipt disappeared after deletion");
    return context.json(receipt);
  });

  app.route("/", createRequestPortalApp(dependencies.requestPortal));

  app.notFound((context) =>
    context.json(errorEnvelope(new PublicError(404, "NOT_FOUND", "Route not found")), 404),
  );

  app.onError((error, context) => {
    if (!(error instanceof PublicError)) {
      console.error("Unhandled request error", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        method: context.req.method,
        path: new URL(context.req.url).pathname,
        requestId: context.get("requestId"),
      });
    }
    const publicError =
      error instanceof PublicError
        ? error
        : new PublicError(500, "INTERNAL_ERROR", "Internal server error", true);
    return context.json(errorEnvelope(publicError), publicError.status as ContentfulStatusCode);
  });

  return app;
}
