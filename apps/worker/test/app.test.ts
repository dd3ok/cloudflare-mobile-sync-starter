import { env } from "cloudflare:workers";
import { LIMITS, type PullResponse, type PushResponse } from "@cloudflare-mobile-sync/api-contract";
import { makeSignature } from "better-auth/crypto";
import { describe, expect, it, vi } from "vitest";
import { type AuthenticatedUser, deleteAccountData } from "../src/account";
import { createApp } from "../src/app";
import {
  createAuth,
  parseVersionedSecrets,
  validateAuthSecrets,
  validateTrustedOrigins,
} from "../src/auth";

interface UserRow {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

const TEST_COLLECTION = "notes-v1";
const RETAINED_COLLECTION = "profile-v2";
const RETAINED_RECORD_ID = "profile-lineage";
const RETAINED_NAMESPACE = "test-namespace";
const RETAINED_SCHEMA = "example.profile/v2";
const DELETION_OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_MOBILE_ORIGIN = "com.example.myapp://";

async function authenticate(request: Request): Promise<AuthenticatedUser | null> {
  const id = request.headers.get("X-Test-User");
  if (!id) return null;
  const user = await env.DB.prepare(`SELECT id, name, email, image FROM user WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
  if (!user) return null;
  const ageHours = Number(request.headers.get("X-Test-Session-Age-Hours") ?? 0);
  return {
    ...user,
    sessionCreatedAt: new Date(Date.now() - ageHours * 60 * 60 * 1_000),
  };
}

const app = createApp({
  authenticate,
  async deleteAccount(_request, requestEnv, user) {
    await requestEnv.DB.prepare(`DELETE FROM user WHERE id = ?`).bind(user.id).run();
  },
});

async function seedUser(id: string, email = `${id}@example.test`): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt)
     VALUES (?, ?, ?, 1, NULL, ?, ?)`,
  )
    .bind(id, id, email, now, now)
    .run();
}

function createTestAuth() {
  return createAuth({
    ...env,
    BETTER_AUTH_SECRET: "0123456789abcdefghijklmnopqrstuvwxyz",
    BETTER_AUTH_SECRETS: "1:0123456789abcdefghijklmnopqrstuvwxyz",
    BETTER_AUTH_URL: "https://sync.example.test",
    TRUSTED_ORIGINS: TEST_MOBILE_ORIGIN,
  });
}

async function seedTestAuthSession(auth: ReturnType<typeof createTestAuth>, suffix: string) {
  const userId = `native-origin-${suffix}-user`;
  const sessionId = `native-origin-${suffix}-session`;
  const sessionToken = `native-origin-${suffix}-token`;
  const now = new Date();
  await seedUser(userId);
  await env.DB.prepare(
    `INSERT INTO session
      (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
  )
    .bind(
      sessionId,
      new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
      sessionToken,
      now.toISOString(),
      now.toISOString(),
      userId,
    )
    .run();

  const context = await auth.$context;
  const signature = await makeSignature(sessionToken, context.secret);
  return {
    sessionId,
    sessionToken,
    cookie: `${context.authCookies.sessionToken.name}=${sessionToken}.${signature}`,
  };
}

async function apiRequest(
  path: string,
  options: RequestInit = {},
  userId?: string,
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (userId) headers.set("X-Test-User", userId);
  return app.request(`https://sync.example.test${path}`, { ...options, headers }, env);
}

async function push(userId: string, mutations: unknown[]): Promise<Response> {
  return apiRequest(
    "/v1/sync/push",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mutations }),
    },
    userId,
  );
}

async function retainedProfileRequest(
  path: string,
  options: RequestInit,
  userId: string,
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("X-Test-User", userId);
  return app.request(
    `https://sync.example.test${path}`,
    { ...options, headers },
    {
      ...env,
      ALLOWED_COLLECTIONS: `${env.ALLOWED_COLLECTIONS},${RETAINED_COLLECTION}`,
      RETAINED_TOMBSTONE_TARGETS: [
        RETAINED_COLLECTION,
        RETAINED_RECORD_ID,
        RETAINED_NAMESPACE,
        RETAINED_SCHEMA,
        "2",
      ].join("|"),
    },
  );
}

async function retainedAccountSlotKey(userId: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${RETAINED_NAMESPACE}:${userId}`),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Worker API", () => {
  it("validates the optional Better Auth rotation keyring", () => {
    expect(
      parseVersionedSecrets(
        "2:abcdefghijklmnopqrstuvwxyz0123456789,1:0123456789abcdefghijklmnopqrstuvwxyz",
      ),
    ).toEqual([
      { version: 2, value: "abcdefghijklmnopqrstuvwxyz0123456789" },
      { version: 1, value: "0123456789abcdefghijklmnopqrstuvwxyz" },
    ]);
    expect(() => parseVersionedSecrets("1:short")).toThrow();
    expect(() =>
      parseVersionedSecrets(
        "1:abcdefghijklmnopqrstuvwxyz0123456789,1:0123456789abcdefghijklmnopqrstuvwxyz",
      ),
    ).toThrow();
    expect(() =>
      validateAuthSecrets({
        BETTER_AUTH_SECRET: "unit-test-only-placeholder-primary-secret",
        BETTER_AUTH_SECRETS: "1:unit-test-only-placeholder-keyring-secret",
      }),
    ).toThrow("placeholder");
    expect(() =>
      validateAuthSecrets({
        BETTER_AUTH_SECRET: "too-short",
        BETTER_AUTH_SECRETS: "1:unit-test-only-placeholder-keyring-secret",
      }),
    ).toThrow("32+ bytes");
  });

  it("requires collision-resistant mobile origins", () => {
    expect(() => validateTrustedOrigins({ TRUSTED_ORIGINS: "my-app://" })).toThrow(
      "reverse-domain",
    );
    expect(
      validateTrustedOrigins({
        TRUSTED_ORIGINS: "com.example.myapp://,https://app.example.com",
      }),
    ).toEqual(["com.example.myapp://", "https://app.example.com"]);
  });

  it("revokes a D1 session from a trusted standard origin", async () => {
    const auth = createTestAuth();
    const session = await seedTestAuthSession(auth, "trusted");

    const response = await auth.handler(
      new Request("https://sync.example.test/v1/auth/revoke-session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          origin: TEST_MOBILE_ORIGIN,
        },
        body: JSON.stringify({ token: session.sessionToken }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    expect(
      await env.DB.prepare(`SELECT id FROM session WHERE id = ?`).bind(session.sessionId).first(),
    ).toBeNull();
  });

  it("preserves a D1 session when the standard origin is untrusted", async () => {
    const auth = createTestAuth();
    const session = await seedTestAuthSession(auth, "untrusted");

    const response = await auth.handler(
      new Request("https://sync.example.test/v1/auth/revoke-session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          origin: "com.example.attacker://",
        },
        body: JSON.stringify({ token: session.sessionToken }),
      }),
    );

    expect(response.status).toBe(403);
    expect(
      await env.DB.prepare(`SELECT id FROM session WHERE id = ?`)
        .bind(session.sessionId)
        .first<string>("id"),
    ).toBe(session.sessionId);
  });

  it("preserves a D1 session when only the private Expo origin header is sent", async () => {
    const auth = createTestAuth();
    const session = await seedTestAuthSession(auth, "private-header");

    const response = await auth.handler(
      new Request("https://sync.example.test/v1/auth/revoke-session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          "expo-origin": TEST_MOBILE_ORIGIN,
        },
        body: JSON.stringify({ token: session.sessionToken }),
      }),
    );

    expect(response.status).toBe(403);
    expect(
      await env.DB.prepare(`SELECT id FROM session WHERE id = ?`)
        .bind(session.sessionId)
        .first<string>("id"),
    ).toBe(session.sessionId);
  });

  it("does not persist attacker-controlled auth rate-limit keys in D1", async () => {
    const before = await env.DB.prepare(`SELECT COUNT(*) AS count FROM rateLimit`).first<number>(
      "count",
    );
    const auth = createAuth({
      ...env,
      BETTER_AUTH_SECRET: "0123456789abcdefghijklmnopqrstuvwxyz",
      BETTER_AUTH_SECRETS: "1:0123456789abcdefghijklmnopqrstuvwxyz",
    });

    await auth.handler(
      new Request(`https://sync.example.test/v1/auth/attacker-controlled-${crypto.randomUUID()}`),
    );

    const after = await env.DB.prepare(`SELECT COUNT(*) AS count FROM rateLimit`).first<number>(
      "count",
    );
    expect(after).toBe(before);
  });

  it("reports health and requires authentication for application data", async () => {
    const health = await apiRequest("/health", { headers: { "CF-Ray": "test-ray" } });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: "v1" });
    expect(health.headers.get("X-Request-ID")).toBe("test-ray");

    const unauthorized = await apiRequest("/v1/sync/pull");
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required",
        retryable: false,
      },
    });
  });

  it("keeps unconfigured collections outside the current application boundary", async () => {
    await seedUser("collection-policy-user");

    for (const collection of ["notes-v1", "app-settings-v1"]) {
      const response = await push("collection-policy-user", [
        {
          mutationId: `collection-policy-${collection}`,
          collection,
          recordId: "record-1",
          operation: "put",
          baseRevision: 0,
          payload: { value: collection },
        },
      ]);
      expect(response.status).toBe(200);
    }

    const notes = await push("collection-policy-user", [
      {
        mutationId: "collection-policy-notes",
        collection: "notes",
        recordId: "record-1",
        operation: "put",
        baseRevision: 0,
        payload: { value: "notes" },
      },
    ]);
    expect(notes.status).toBe(403);

    const currentAppCollection = await push("collection-policy-user", [
      {
        mutationId: "collection-policy-current-app",
        collection: "another-product-records-v2",
        recordId: "record-1",
        operation: "put",
        baseRevision: 0,
        payload: { value: "current-app" },
      },
    ]);
    expect(currentAppCollection.status).toBe(403);
  });

  it("logs an opaque unexpected error without leaking its message", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingApp = createApp({
      authenticate: async () => {
        throw new Error("cookie=session-secret");
      },
    });

    try {
      const response = await failingApp.request("https://sync.example.test/v1/sync/pull", {}, env);

      expect(response.status).toBe(500);
      expect(response.headers.get("X-Request-ID")).toBeTruthy();
      expect(errorLog).toHaveBeenCalledOnce();
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("session-secret");
    } finally {
      errorLog.mockRestore();
    }
  });

  it("applies CAS mutations atomically, replays idempotently, and pages changes", async () => {
    await seedUser("alice");
    await seedUser("bob");

    const create = await push("alice", [
      {
        mutationId: "alice-create",
        collection: TEST_COLLECTION,
        recordId: "note-1",
        operation: "put",
        baseRevision: 0,
        payload: { title: "first" },
      },
    ]);
    expect(create.status).toBe(200);
    const created = (await create.json()) as PushResponse;
    expect(created.results[0]).toMatchObject({
      mutationId: "alice-create",
      status: "accepted",
      replayed: false,
      record: { revision: 1, deleted: false, payload: { title: "first" } },
    });

    const replay = await push("alice", [
      {
        mutationId: "alice-create",
        collection: TEST_COLLECTION,
        recordId: "note-1",
        operation: "put",
        baseRevision: 0,
        payload: { title: "different retry body" },
      },
    ]);
    expect((await replay.json()) as PushResponse).toMatchObject({
      results: [
        {
          mutationId: "alice-create",
          status: "accepted",
          replayed: true,
          record: { revision: 1, payload: { title: "first" } },
        },
      ],
    });

    const stale = await push("alice", [
      {
        mutationId: "alice-stale",
        collection: TEST_COLLECTION,
        recordId: "note-1",
        operation: "put",
        baseRevision: 0,
        payload: { title: "stale" },
      },
    ]);
    expect((await stale.json()) as PushResponse).toMatchObject({
      results: [
        {
          status: "conflict",
          replayed: false,
          current: { revision: 1, payload: { title: "first" } },
        },
      ],
    });

    const update = await push("alice", [
      {
        mutationId: "alice-update",
        collection: TEST_COLLECTION,
        recordId: "note-1",
        operation: "put",
        baseRevision: 1,
        payload: { title: "second" },
      },
      {
        mutationId: "alice-delete",
        collection: TEST_COLLECTION,
        recordId: "note-1",
        operation: "delete",
        baseRevision: 2,
      },
    ]);
    const updated = (await update.json()) as PushResponse;
    expect(updated.results).toMatchObject([
      { status: "accepted", record: { revision: 3, deleted: true, payload: null } },
      { status: "accepted", record: { revision: 3, deleted: true, payload: null } },
    ]);

    await push("alice", [
      {
        mutationId: "alice-page-one",
        collection: TEST_COLLECTION,
        recordId: "page-one",
        operation: "put",
        baseRevision: 0,
        payload: { page: 1 },
      },
      {
        mutationId: "alice-page-two",
        collection: TEST_COLLECTION,
        recordId: "page-two",
        operation: "put",
        baseRevision: 0,
        payload: { page: 2 },
      },
    ]);

    const firstPage = await apiRequest("/v1/sync/pull?cursor=0&limit=2", {}, "alice");
    const firstPull = (await firstPage.json()) as PullResponse;
    expect(firstPull.changes).toHaveLength(2);
    expect(firstPull.hasMore).toBe(true);
    const secondPage = await apiRequest(
      `/v1/sync/pull?cursor=${firstPull.nextCursor}&limit=2`,
      {},
      "alice",
    );
    const secondPull = (await secondPage.json()) as PullResponse;
    expect(secondPull.changes).toMatchObject([{ recordId: "page-two", deleted: false }]);
    expect(secondPull.hasMore).toBe(false);

    const bobPull = await apiRequest("/v1/sync/pull?cursor=0", {}, "bob");
    expect(await bobPull.json()).toEqual({ changes: [], nextCursor: 0, hasMore: false });
    const bobConflict = await push("bob", [
      {
        mutationId: "bob-stale",
        collection: TEST_COLLECTION,
        recordId: "note-1",
        operation: "put",
        baseRevision: 3,
        payload: { title: "forged revision" },
      },
    ]);
    expect((await bobConflict.json()) as PushResponse).toMatchObject({
      results: [{ status: "conflict", current: null }],
    });
    const bobDelete = await push("bob", [
      {
        mutationId: "bob-delete",
        collection: TEST_COLLECTION,
        recordId: "note-1",
        operation: "delete",
        baseRevision: 3,
      },
    ]);
    expect((await bobDelete.json()) as PushResponse).toMatchObject({
      results: [{ status: "conflict", current: null }],
    });
  });

  it("keeps a tombstone but erases superseded payload copies after record deletion", async () => {
    await seedUser("privacy-delete-user");

    await push("privacy-delete-user", [
      {
        mutationId: "privacy-create",
        collection: TEST_COLLECTION,
        recordId: "private-record",
        operation: "put",
        baseRevision: 0,
        payload: { secret: "first-private-value" },
      },
    ]);
    await push("privacy-delete-user", [
      {
        mutationId: "privacy-update",
        collection: TEST_COLLECTION,
        recordId: "private-record",
        operation: "put",
        baseRevision: 1,
        payload: { secret: "second-private-value" },
      },
      {
        mutationId: "privacy-conflict",
        collection: TEST_COLLECTION,
        recordId: "private-record",
        operation: "put",
        baseRevision: 0,
        payload: { secret: "rejected-private-value" },
      },
    ]);
    const deletion = await push("privacy-delete-user", [
      {
        mutationId: "privacy-delete",
        collection: TEST_COLLECTION,
        recordId: "private-record",
        operation: "delete",
        baseRevision: 2,
      },
    ]);
    expect((await deletion.json()) as PushResponse).toMatchObject({
      results: [
        {
          mutationId: "privacy-delete",
          status: "accepted",
          replayed: false,
          record: { revision: 3, deleted: true, payload: null },
        },
      ],
    });

    const pull = await apiRequest("/v1/sync/pull?cursor=0", {}, "privacy-delete-user");
    expect(await pull.json()).toMatchObject({
      changes: [{ revision: 3, deleted: true, payload: null }],
      hasMore: false,
    });

    const createReplay = await push("privacy-delete-user", [
      {
        mutationId: "privacy-create",
        collection: TEST_COLLECTION,
        recordId: "private-record",
        operation: "put",
        baseRevision: 0,
        payload: { secret: "different-retry-value" },
      },
    ]);
    expect((await createReplay.json()) as PushResponse).toMatchObject({
      results: [
        {
          mutationId: "privacy-create",
          status: "accepted",
          replayed: true,
          record: { revision: 3, deleted: true, payload: null },
        },
      ],
    });

    const conflictReplay = await push("privacy-delete-user", [
      {
        mutationId: "privacy-conflict",
        collection: TEST_COLLECTION,
        recordId: "private-record",
        operation: "put",
        baseRevision: 0,
        payload: { secret: "another-retry-value" },
      },
    ]);
    expect((await conflictReplay.json()) as PushResponse).toMatchObject({
      results: [
        {
          mutationId: "privacy-conflict",
          status: "conflict",
          replayed: true,
          current: { revision: 3, deleted: true, payload: null },
        },
      ],
    });

    const deleteReplay = await push("privacy-delete-user", [
      {
        mutationId: "privacy-delete",
        collection: TEST_COLLECTION,
        recordId: "private-record",
        operation: "delete",
        baseRevision: 2,
      },
    ]);
    expect((await deleteReplay.json()) as PushResponse).toMatchObject({
      results: [
        {
          mutationId: "privacy-delete",
          status: "accepted",
          replayed: true,
          record: { revision: 3, deleted: true, payload: null },
        },
      ],
    });

    const persisted = await env.DB.prepare(
      `SELECT payload FROM sync_changes WHERE user_id = ?
       UNION ALL
       SELECT payload FROM sync_mutations WHERE user_id = ?
       UNION ALL
       SELECT result_payload AS payload FROM sync_mutations WHERE user_id = ?`,
    )
      .bind("privacy-delete-user", "privacy-delete-user", "privacy-delete-user")
      .all<{ payload: string | null }>();
    expect(persisted.results).not.toHaveLength(0);
    expect(persisted.results.every((row) => row.payload === null)).toBe(true);
    expect(JSON.stringify(persisted.results)).not.toContain("private-value");
  });

  it("retains a strict lineage tombstone while transactionally scrubbing prior profile payloads", async () => {
    const userId = `retained-tombstone-${crypto.randomUUID()}`;
    await seedUser(userId);
    const profileEnv = {
      ...env,
      ALLOWED_COLLECTIONS: `${env.ALLOWED_COLLECTIONS},${RETAINED_COLLECTION}`,
      RETAINED_TOMBSTONE_TARGETS: [
        RETAINED_COLLECTION,
        RETAINED_RECORD_ID,
        RETAINED_NAMESPACE,
        RETAINED_SCHEMA,
        "2",
      ].join("|"),
    };
    const profilePush = async (mutations: unknown[]) => {
      const headers = new Headers({ "Content-Type": "application/json", "X-Test-User": userId });
      return app.request(
        "https://sync.example.test/v1/sync/push",
        { method: "POST", headers, body: JSON.stringify({ mutations }) },
        profileEnv,
      );
    };
    const sensitiveDate = "1988-02-03";
    expect(
      (
        await profilePush([
          {
            mutationId: "profile-sensitive-create",
            collection: RETAINED_COLLECTION,
            recordId: RETAINED_RECORD_ID,
            baseRevision: 0,
            operation: "put",
            payload: { birthDate: sensitiveDate, name: "private" },
          },
          {
            mutationId: "profile-sensitive-update",
            collection: RETAINED_COLLECTION,
            recordId: RETAINED_RECORD_ID,
            baseRevision: 1,
            operation: "put",
            payload: { birthDate: sensitiveDate, birthTime: "12:34" },
          },
        ])
      ).status,
    ).toBe(200);
    const accountSlotKey = await retainedAccountSlotKey(userId);
    const tombstone = {
      v: 2,
      accountSlotKey,
      head: {
        schema: RETAINED_SCHEMA,
        lineageId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        ancestorVersionIds: ["33333333-3333-4333-8333-333333333333"],
        writtenAt: "2026-08-13T00:00:00.000Z",
        value: { state: "deleted" },
      },
      consent: null,
    };
    const compact = await retainedProfileRequest(
      "/v1/sync/retained-tombstone",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: "profile-retained-delete",
          collection: RETAINED_COLLECTION,
          recordId: RETAINED_RECORD_ID,
          baseRevision: 2,
          tombstone,
        }),
      },
      userId,
    );
    expect(compact.status).toBe(200);
    expect(await compact.json()).toMatchObject({
      status: "accepted",
      replayed: false,
      record: { revision: 3, deleted: false, payload: tombstone },
      receipt: { operationId: "profile-retained-delete" },
    });

    const pull = await retainedProfileRequest(
      `/v1/sync/pull?cursor=0&collection=${RETAINED_COLLECTION}`,
      {},
      userId,
    );
    expect(await pull.json()).toMatchObject({
      changes: [{ revision: 3, payload: tombstone }],
      hasMore: false,
    });
    const storedCopies = await env.DB.prepare(
      `SELECT payload AS value FROM sync_changes WHERE user_id = ?
       UNION ALL SELECT payload FROM sync_mutations WHERE user_id = ?
       UNION ALL SELECT result_payload FROM sync_mutations WHERE user_id = ?`,
    )
      .bind(userId, userId, userId)
      .all<{ value: string | null }>();
    expect(JSON.stringify(storedCopies.results)).not.toContain(sensitiveDate);

    const retainedReplay = await retainedProfileRequest(
      "/v1/sync/retained-tombstone",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: "profile-retained-delete",
          collection: RETAINED_COLLECTION,
          recordId: RETAINED_RECORD_ID,
          baseRevision: 2,
          tombstone,
        }),
      },
      userId,
    );
    expect(await retainedReplay.json()).toMatchObject({
      status: "accepted",
      replayed: true,
      record: { payload: tombstone },
    });

    const replay = await profilePush([
      {
        mutationId: "profile-sensitive-create",
        collection: RETAINED_COLLECTION,
        recordId: RETAINED_RECORD_ID,
        baseRevision: 0,
        operation: "put",
        payload: { birthDate: sensitiveDate, name: "private" },
      },
    ]);
    expect(await replay.json()).toMatchObject({
      results: [{ replayed: true, record: { revision: 3, payload: tombstone } }],
    });
  });

  it("rejects retained tombstone escalation and leaves history unchanged on conflict", async () => {
    const userId = `retained-tombstone-negative-${crypto.randomUUID()}`;
    await seedUser(userId);
    const accountSlotKey = await retainedAccountSlotKey(userId);
    const request = (overrides: Record<string, unknown> = {}) =>
      retainedProfileRequest(
        "/v1/sync/retained-tombstone",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operationId: `negative-${crypto.randomUUID()}`,
            collection: RETAINED_COLLECTION,
            recordId: RETAINED_RECORD_ID,
            baseRevision: 0,
            tombstone: {
              v: 2,
              accountSlotKey,
              head: {
                schema: RETAINED_SCHEMA,
                lineageId: "11111111-1111-4111-8111-111111111111",
                versionId: "22222222-2222-4222-8222-222222222222",
                ancestorVersionIds: [],
                writtenAt: "2026-08-13T00:00:00.000Z",
                value: { state: "deleted" },
              },
              consent: null,
            },
            ...overrides,
          }),
        },
        userId,
      );

    expect((await request({ collection: TEST_COLLECTION })).status).toBe(403);
    expect((await request({ recordId: "another-profile" })).status).toBe(403);
    expect(
      (
        await request({
          tombstone: {
            v: 2,
            accountSlotKey,
            head: {
              schema: RETAINED_SCHEMA,
              lineageId: "11111111-1111-4111-8111-111111111111",
              versionId: "22222222-2222-4222-8222-222222222222",
              ancestorVersionIds: [],
              writtenAt: "2026-08-13T00:00:00.000Z",
              value: { state: "deleted", profile: { birthDate: "1988-02-03" } },
            },
            consent: null,
          },
        })
      ).status,
    ).toBe(400);

    await push(userId, [
      {
        mutationId: "unrelated-sensitive-record",
        collection: TEST_COLLECTION,
        recordId: "keep-me",
        baseRevision: 0,
        operation: "put",
        payload: { birthDate: "1988-02-03" },
      },
    ]);
    const conflict = await request({ baseRevision: 9 });
    expect(await conflict.json()).toMatchObject({ status: "conflict" });
    const unrelated = await env.DB.prepare(
      `SELECT payload FROM sync_changes WHERE user_id = ? AND collection = ? AND record_id = ?`,
    )
      .bind(userId, TEST_COLLECTION, "keep-me")
      .first<{ payload: string }>();
    expect(unrelated?.payload).toContain("1988-02-03");
  });

  it("paginates an exact collection feed without scanning unrelated changes", async () => {
    await seedUser("filtered-pull-user");
    await push("filtered-pull-user", [
      {
        mutationId: "filtered-reading-one",
        collection: TEST_COLLECTION,
        recordId: "reading-one",
        operation: "put",
        baseRevision: 0,
        payload: { kind: "reading-one" },
      },
      {
        mutationId: "filtered-theme",
        collection: "app-settings-v1",
        recordId: "theme",
        operation: "put",
        baseRevision: 0,
        payload: { kind: "theme" },
      },
      {
        mutationId: "filtered-reading-two",
        collection: TEST_COLLECTION,
        recordId: "reading-two",
        operation: "put",
        baseRevision: 0,
        payload: { kind: "reading-two" },
      },
    ]);

    const firstPage = await apiRequest(
      `/v1/sync/pull?cursor=0&limit=1&collection=${TEST_COLLECTION}`,
      {},
      "filtered-pull-user",
    );
    expect(firstPage.status).toBe(200);
    const first = (await firstPage.json()) as PullResponse;
    expect(first).toMatchObject({
      changes: [{ collection: TEST_COLLECTION, recordId: "reading-one" }],
      hasMore: true,
    });

    const secondPage = await apiRequest(
      `/v1/sync/pull?cursor=${first.nextCursor}&limit=1&collection=${TEST_COLLECTION}`,
      {},
      "filtered-pull-user",
    );
    const second = (await secondPage.json()) as PullResponse;
    expect(second).toMatchObject({
      changes: [{ collection: TEST_COLLECTION, recordId: "reading-two" }],
      hasMore: false,
    });

    const themePage = await apiRequest(
      "/v1/sync/pull?cursor=0&collection=app-settings-v1",
      {},
      "filtered-pull-user",
    );
    expect(await themePage.json()).toMatchObject({
      changes: [{ collection: "app-settings-v1", recordId: "theme" }],
      hasMore: false,
    });

    const wrongCursorForTheme = await apiRequest(
      `/v1/sync/pull?cursor=${second.nextCursor}&collection=app-settings-v1`,
      {},
      "filtered-pull-user",
    );
    expect(await wrongCursorForTheme.json()).toEqual({
      changes: [],
      nextCursor: second.nextCursor,
      hasMore: false,
    });

    const forbidden = await apiRequest(
      "/v1/sync/pull?cursor=0&collection=not-allowed",
      {},
      "filtered-pull-user",
    );
    expect(forbidden.status).toBe(403);

    const invalid = await apiRequest(
      "/v1/sync/pull?cursor=0&collection=not%20allowed",
      {},
      "filtered-pull-user",
    );
    expect(invalid.status).toBe(400);
  });

  it("accepts only one of two concurrent updates from the same base revision", async () => {
    await seedUser("concurrent-user");
    await push("concurrent-user", [
      {
        mutationId: "concurrent-create",
        collection: TEST_COLLECTION,
        recordId: "shared-note",
        operation: "put",
        baseRevision: 0,
        payload: { value: "initial" },
      },
    ]);

    const [left, right] = await Promise.all([
      push("concurrent-user", [
        {
          mutationId: "concurrent-left",
          collection: TEST_COLLECTION,
          recordId: "shared-note",
          operation: "put",
          baseRevision: 1,
          payload: { value: "left" },
        },
      ]),
      push("concurrent-user", [
        {
          mutationId: "concurrent-right",
          collection: TEST_COLLECTION,
          recordId: "shared-note",
          operation: "put",
          baseRevision: 1,
          payload: { value: "right" },
        },
      ]),
    ]);
    const results = [
      ((await left.json()) as PushResponse).results[0],
      ((await right.json()) as PushResponse).results[0],
    ];

    expect(results.filter((result) => result?.status === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result?.status === "conflict")).toHaveLength(1);
    expect(
      results.every((result) => result?.status === "accepted" || result?.current?.revision === 2),
    ).toBe(true);
  });

  it("accepts a full 25-mutation push without exceeding the D1 query budget", async () => {
    await seedUser("full-batch-user");
    const response = await push(
      "full-batch-user",
      Array.from({ length: 25 }, (_, index) => ({
        mutationId: `full-batch-${index}`,
        collection: TEST_COLLECTION,
        recordId: `full-batch-note-${index}`,
        operation: "put",
        baseRevision: 0,
        payload: { index },
      })),
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as PushResponse).results).toHaveLength(25);
  });

  it("prevents one provider identity from belonging to two local users", async () => {
    await seedUser("identity-owner");
    await seedUser("identity-attacker");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind("identity-owner-account", "same-provider-subject", "google", "identity-owner", now, now)
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          "identity-attacker-account",
          "same-provider-subject",
          "google",
          "identity-attacker",
          now,
          now,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("rejects forged scope, unknown fields, and disallowed collections", async () => {
    await seedUser("mallory");
    const forged = await apiRequest(
      "/v1/sync/push",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "alice",
          mutations: [
            {
              mutationId: "forged",
              collection: TEST_COLLECTION,
              recordId: "note-1",
              operation: "delete",
              baseRevision: 1,
            },
          ],
        }),
      },
      "mallory",
    );
    expect(forged.status).toBe(400);

    const unknownField = await push("mallory", [
      {
        mutationId: "unknown-field",
        collection: TEST_COLLECTION,
        recordId: "note-1",
        operation: "delete",
        baseRevision: 0,
        userId: "alice",
      },
    ]);
    expect(unknownField.status).toBe(400);

    const disallowed = await push("mallory", [
      {
        mutationId: "wrong-collection",
        collection: "secrets",
        recordId: "note-1",
        operation: "delete",
        baseRevision: 0,
      },
    ]);
    expect(disallowed.status).toBe(403);

    const malformed = await apiRequest(
      "/v1/sync/push",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      },
      "mallory",
    );
    expect(malformed.status).toBe(400);

    const oversized = await apiRequest(
      "/v1/sync/push",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(LIMITS.requestBodyBytes + 1),
      },
      "mallory",
    );
    expect(oversized.status).toBe(413);
  });

  it("stops reading a streamed request as soon as the body limit is exceeded", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(LIMITS.requestBodyBytes + 1));
          return;
        }
        throw new Error("the oversized request should have been cancelled");
      },
    });
    const request = new Request("https://sync.example.test/v1/sync/push", {
      method: "POST",
      headers: { "X-Test-User": "mallory" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.fetch(request, env);

    expect(response.status).toBe(413);
    expect(pulls).toBe(1);
  });

  it("hides placeholder email and deletes server data with the account", async () => {
    await seedUser("private-user", "provider.abcd@placeholder.invalid");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind("account-1", "provider-subject", "kakao", "private-user", now, now)
      .run();
    await push("private-user", [
      {
        mutationId: "private-create",
        collection: TEST_COLLECTION,
        recordId: "private-note",
        operation: "put",
        baseRevision: 0,
        payload: { private: true },
      },
    ]);

    const account = await apiRequest("/v1/account", {}, "private-user");
    expect(await account.json()).toMatchObject({
      user: { email: null, emailIsPlaceholder: true },
      providers: [{ providerId: "kakao", accountId: "provider-subject" }],
    });

    const staleSession = await apiRequest(
      "/v1/account",
      {
        method: "DELETE",
        headers: {
          "X-Test-Session-Age-Hours": "25",
          "X-Mobile-Sync-Expected-Subject": "private-user",
          "X-Mobile-Sync-Deletion-Operation": DELETION_OPERATION_ID,
        },
      },
      "private-user",
    );
    expect(staleSession.status).toBe(401);

    const missingSubject = await apiRequest("/v1/account", { method: "DELETE" }, "private-user");
    expect(missingSubject.status).toBe(409);

    const wrongSubject = await apiRequest(
      "/v1/account",
      {
        method: "DELETE",
        headers: { "X-Mobile-Sync-Expected-Subject": "another-user" },
      },
      "private-user",
    );
    expect(wrongSubject.status).toBe(409);

    const deletion = await apiRequest(
      "/v1/account",
      {
        method: "DELETE",
        headers: {
          "X-Mobile-Sync-Expected-Subject": "private-user",
          "X-Mobile-Sync-Deletion-Operation": DELETION_OPERATION_ID,
        },
      },
      "private-user",
    );
    expect(deletion.status).toBe(200);
    expect(await deletion.json()).toMatchObject({
      operationId: DELETION_OPERATION_ID,
      serverDataDeleted: true,
      providerRevocations: [],
    });
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS count FROM user WHERE id = ?`)
        .bind("private-user")
        .first("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS count FROM sync_records WHERE user_id = ?`)
        .bind("private-user")
        .first("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS count FROM sync_changes WHERE user_id = ?`)
        .bind("private-user")
        .first("count"),
    ).toBe(0);

    const afterDeletion = await apiRequest("/v1/sync/pull", {}, "private-user");
    expect(afterDeletion.status).toBe(401);
  });

  it("does not let a provider outage block local account deletion", async () => {
    await seedUser("provider-outage-user");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "provider-outage-account",
        "provider-subject",
        "google",
        "provider-outage-user",
        now,
        now,
      )
      .run();
    await push("provider-outage-user", [
      {
        mutationId: "provider-outage-create",
        collection: TEST_COLLECTION,
        recordId: "private-record",
        operation: "put",
        baseRevision: 0,
        payload: { private: true },
      },
    ]);

    const outcome = await deleteAccountData(env.DB, "provider-outage-user");

    expect(outcome).toEqual({ providerIds: ["google"], providerRevocationFailures: ["google"] });
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS count FROM user WHERE id = ?`)
        .bind("provider-outage-user")
        .first("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS count FROM sync_records WHERE user_id = ?`)
        .bind("provider-outage-user")
        .first("count"),
    ).toBe(0);
  });

  it("returns and recovers a PII-free provider revocation outcome after response loss", async () => {
    const userId = `deletion-receipt-${crypto.randomUUID()}`;
    await seedUser(userId);
    const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const deletionApp = createApp({
      authenticate,
      async deleteAccount(_request, requestEnv, user) {
        await requestEnv.DB.prepare(`DELETE FROM user WHERE id = ?`).bind(user.id).run();
        return { providerIds: ["google"], providerRevocationFailures: ["google"] };
      },
    });
    const response = await deletionApp.request(
      "https://sync.example.test/v1/account",
      {
        method: "DELETE",
        headers: {
          "X-Test-User": userId,
          "X-Mobile-Sync-Expected-Subject": userId,
          "X-Mobile-Sync-Deletion-Operation": operationId,
        },
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operationId,
      serverDataDeleted: true,
      providerRevocations: [{ providerId: "google", status: "unconfirmed" }],
    });

    const recovered = await deletionApp.request(
      "https://sync.example.test/v1/account-deletions/status",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId, expectedSubjectId: userId }),
      },
      env,
    );
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      operationId,
      serverDataDeleted: true,
      providerRevocations: [{ providerId: "google", status: "unconfirmed" }],
    });
    const wrongSubject = await deletionApp.request(
      "https://sync.example.test/v1/account-deletions/status",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId, expectedSubjectId: "another-user" }),
      },
      env,
    );
    expect(wrongSubject.status).toBe(404);
    const persisted = await env.DB.prepare(
      `SELECT operation_hash, subject_hash, result_json FROM account_deletion_receipt
       WHERE operation_hash = ?`,
    )
      .bind(await sha256Hex(operationId))
      .first<{ operation_hash: string; subject_hash: string; result_json: string }>();
    expect(persisted).not.toBeNull();
    expect(persisted?.operation_hash).not.toContain(operationId);
    expect(persisted?.subject_hash).not.toContain(userId);
    expect(persisted?.result_json).not.toContain(operationId);
    expect(persisted?.result_json).not.toContain(userId);
  });

  it("fails closed when the local account does not exist", async () => {
    await expect(deleteAccountData(env.DB, "missing-user")).rejects.toThrow(
      "Account deletion did not delete a user",
    );
  });
});
