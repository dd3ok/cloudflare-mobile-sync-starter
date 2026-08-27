import { describe, expect, it } from "vitest";
import {
  createSyncClient,
  type HttpTransport,
  type SyncClient,
  type SyncStore,
  syncOnce,
  type TransportRequest,
  type TransportResponse,
} from "./index";

class FakeTransport implements HttpTransport {
  readonly requests: TransportRequest[] = [];
  constructor(private readonly responses: TransportResponse[]) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No fake response configured");
    return response;
  }
}

const retry = {
  random: () => 0,
  sleep: async () => undefined,
};

describe("createSyncClient", () => {
  it("binds destructive account deletion to the expected subject", async () => {
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const transport = new FakeTransport([
      {
        status: 200,
        body: {
          operationId,
          serverDataDeleted: true,
          providerRevocations: [],
          completedAt: "2026-08-13T00:00:00.000Z",
        },
      },
    ]);
    const client = createSyncClient({ transport, retry });

    await expect(client.deleteAccount("account-a", operationId)).resolves.toMatchObject({
      operationId,
      serverDataDeleted: true,
    });

    expect(transport.requests[0]).toMatchObject({
      method: "DELETE",
      path: "/v1/account",
      headers: {
        "X-Mobile-Sync-Expected-Subject": "account-a",
        "X-Mobile-Sync-Deletion-Operation": operationId,
      },
    });
  });

  it("recovers a completed account deletion by its capability-bound receipt", async () => {
    const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const outcome = {
      operationId,
      serverDataDeleted: true as const,
      providerRevocations: [{ providerId: "google", status: "unconfirmed" as const }],
      completedAt: "2026-08-13T00:00:00.000Z",
    };
    const transport = new FakeTransport([{ status: 200, body: outcome }]);
    const client = createSyncClient({ transport, retry });

    await expect(client.accountDeletionStatus("account-a", operationId)).resolves.toEqual(outcome);
    expect(transport.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/account-deletions/status",
      body: { expectedSubjectId: "account-a", operationId },
    });
  });

  it("injects authentication without coupling core to cookies", async () => {
    const transport = new FakeTransport([{ status: 200, body: { ok: true, version: "v1" } }]);
    const client = createSyncClient({
      transport,
      retry,
      authHeaders: async () => ({ Cookie: "session=opaque" }),
    });

    await client.health();

    expect(transport.requests[0]?.headers.Cookie).toBe("session=opaque");
  });

  it("retries bounded transient failures", async () => {
    const transport = new FakeTransport([
      {
        status: 503,
        body: {
          error: { code: "INTERNAL_ERROR", message: "temporary", retryable: true },
        },
      },
      { status: 200, body: { ok: true, version: "v1" } },
    ]);
    const delays: number[] = [];
    const client = createSyncClient({
      transport,
      retry: { random: () => 0, sleep: async (delay) => void delays.push(delay) },
    });

    await expect(client.health()).resolves.toEqual({ ok: true, version: "v1" });
    expect(transport.requests).toHaveLength(2);
    expect(delays).toEqual([125]);
  });

  it("rejects invalid input before transport", async () => {
    const transport = new FakeTransport([]);
    const client = createSyncClient({ transport, retry });

    await expect(
      client.push({
        mutations: [
          {
            mutationId: "bad space",
            collection: "notes",
            recordId: "one",
            baseRevision: 0,
            operation: "delete",
          },
        ],
      }),
    ).rejects.toThrow();
    expect(transport.requests).toHaveLength(0);
  });

  it("requests an exact collection feed with its own cursor", async () => {
    const transport = new FakeTransport([
      {
        status: 200,
        body: { changes: [], nextCursor: 17, hasMore: false },
      },
    ]);
    const client = createSyncClient({ transport, retry });

    await client.pull({ cursor: 17, limit: 10, collection: "notes-v1" });

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.path).toBe(
      "/v1/sync/pull?cursor=17&limit=10&collection=notes-v1",
    );
  });

  it("sends retained tombstone compaction through its explicit operation", async () => {
    const tombstone = {
      v: 2,
      accountSlotKey: "a".repeat(64),
      head: {
        schema: "example.profile/v2",
        lineageId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        ancestorVersionIds: [],
        writtenAt: "2026-08-13T00:00:00.000Z",
        value: { state: "deleted" as const },
      },
      consent: null,
    };
    const transport = new FakeTransport([
      {
        status: 200,
        body: {
          operationId: "erase-profile",
          status: "accepted",
          replayed: false,
          record: {
            collection: "profile-v2",
            recordId: "profile-lineage",
            revision: 2,
            cursor: 9,
            deleted: false,
            payload: tombstone,
            updatedAt: "2026-08-13T00:00:01.000Z",
          },
          receipt: {
            operationId: "erase-profile",
            completedAt: "2026-08-13T00:00:01.000Z",
          },
        },
      },
    ]);
    const client = createSyncClient({ transport, retry });

    await client.retainTombstone({
      operationId: "erase-profile",
      collection: "profile-v2",
      recordId: "profile-lineage",
      baseRevision: 1,
      tombstone,
    });

    expect(transport.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/sync/retained-tombstone",
      body: {
        operationId: "erase-profile",
        collection: "profile-v2",
        recordId: "profile-lineage",
        baseRevision: 1,
        tombstone,
      },
    });
  });
});

describe("syncOnce", () => {
  it("pushes pending work before pulling bounded cursor pages", async () => {
    const calls: string[] = [];
    let cursor = 0;
    const store: SyncStore = {
      async getPendingMutations() {
        calls.push("pending");
        return [
          {
            mutationId: "create-one",
            collection: "notes",
            recordId: "one",
            operation: "put",
            baseRevision: 0,
            payload: { title: "local" },
          },
        ];
      },
      async applyPushResults() {
        calls.push("apply-push");
      },
      async getPullCursor() {
        calls.push("cursor");
        return cursor;
      },
      async applyPulledChanges(_changes, nextCursor) {
        calls.push(`apply-pull-${nextCursor}`);
        cursor = nextCursor;
      },
    };
    let pullCount = 0;
    const client: SyncClient = {
      health: async () => ({ ok: true, version: "v1" }),
      account: async () => ({
        user: { id: "one", name: "One", email: null, emailIsPlaceholder: true, image: null },
        providers: [],
      }),
      deleteAccount: async () => ({
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        serverDataDeleted: true,
        providerRevocations: [],
        completedAt: "2026-08-13T00:00:00.000Z",
      }),
      accountDeletionStatus: async () => ({
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        serverDataDeleted: true,
        providerRevocations: [],
        completedAt: "2026-08-13T00:00:00.000Z",
      }),
      retainTombstone: async () => {
        throw new Error("not used");
      },
      async push() {
        calls.push("push");
        return {
          results: [
            {
              mutationId: "create-one",
              status: "accepted",
              replayed: false,
              record: {
                collection: "notes",
                recordId: "one",
                revision: 1,
                cursor: 1,
                deleted: false,
                payload: { title: "local" },
                updatedAt: "2026-07-20T00:00:00.000Z",
              },
            },
          ],
        };
      },
      async pull(query) {
        calls.push("pull");
        expect(query?.limit).toBe(50);
        pullCount += 1;
        return pullCount === 1
          ? { changes: [], nextCursor: 1, hasMore: true }
          : { changes: [], nextCursor: 1, hasMore: false };
      },
    };

    await expect(syncOnce(client, store)).resolves.toEqual({
      pushed: 1,
      accepted: 1,
      conflicts: 0,
      pulled: 0,
      pages: 2,
      nextCursor: 1,
      hasMore: false,
    });
    expect(calls).toEqual([
      "pending",
      "push",
      "apply-push",
      "cursor",
      "pull",
      "apply-pull-1",
      "pull",
      "apply-pull-1",
    ]);
  });
});
