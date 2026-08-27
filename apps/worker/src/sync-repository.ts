import type {
  JsonValue,
  MutationResult,
  PullResponse,
  SyncMutation,
  SyncRecord,
} from "@cloudflare-mobile-sync/api-contract";

interface MutationReceiptRow {
  mutation_id: string;
  status: "accepted" | "conflict";
  result_collection: string | null;
  result_record_id: string | null;
  result_revision: number | null;
  result_cursor: number | null;
  result_deleted: number | null;
  result_payload: string | null;
  result_updated_at: string | null;
}

interface ChangeRow {
  collection: string;
  record_id: string;
  revision: number;
  cursor: number;
  deleted: number;
  payload: string | null;
  updated_at: string;
}

function parsePayload(payload: string | null): JsonValue | null {
  return payload === null ? null : (JSON.parse(payload) as JsonValue);
}

function recordFromRow(row: ChangeRow): SyncRecord {
  return {
    collection: row.collection,
    recordId: row.record_id,
    revision: row.revision,
    cursor: row.cursor,
    deleted: row.deleted === 1,
    payload: parsePayload(row.payload),
    updatedAt: row.updated_at,
  };
}

function recordFromReceipt(row: MutationReceiptRow): SyncRecord | null {
  if (
    row.result_collection === null ||
    row.result_record_id === null ||
    row.result_revision === null ||
    row.result_cursor === null ||
    row.result_deleted === null ||
    row.result_updated_at === null
  ) {
    return null;
  }

  return {
    collection: row.result_collection,
    recordId: row.result_record_id,
    revision: row.result_revision,
    cursor: row.result_cursor,
    deleted: row.result_deleted === 1,
    payload: parsePayload(row.result_payload),
    updatedAt: row.result_updated_at,
  };
}

export async function pushMutations(
  db: D1Database,
  userId: string,
  mutations: readonly SyncMutation[],
): Promise<MutationResult[]> {
  if (mutations.length === 0) return [];
  const createdAt = new Date().toISOString();
  const inserts = mutations.map((mutation) =>
    db
      .prepare(
        `INSERT INTO sync_mutations (
          user_id, mutation_id, collection, record_id, operation,
          base_revision, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, mutation_id) DO NOTHING`,
      )
      .bind(
        userId,
        mutation.mutationId,
        mutation.collection,
        mutation.recordId,
        mutation.operation,
        mutation.baseRevision,
        mutation.operation === "put" ? JSON.stringify(mutation.payload) : null,
        createdAt,
      ),
  );
  const placeholders = mutations.map(() => "?").join(", ");
  const receipts = db
    .prepare(
      `SELECT mutation_id, status, result_collection, result_record_id,
        result_revision, result_cursor, result_deleted, result_payload,
        result_updated_at
      FROM sync_mutations
      WHERE user_id = ? AND mutation_id IN (${placeholders})`,
    )
    .bind(userId, ...mutations.map((mutation) => mutation.mutationId));

  const batchResults = await db.batch([...inserts, receipts]);
  const receiptResult = batchResults[mutations.length] as D1Result<MutationReceiptRow> | undefined;
  if (!receiptResult) throw new Error("Mutation batch returned no receipts");
  const receiptByMutationId = new Map(
    receiptResult.results.map((receipt) => [receipt.mutation_id, receipt]),
  );

  return mutations.map((mutation, index) => {
    const insertResult = batchResults[index];
    if (!insertResult) throw new Error("Mutation batch returned no insert result");
    const row = receiptByMutationId.get(mutation.mutationId);
    if (!row || (row.status !== "accepted" && row.status !== "conflict")) {
      throw new Error("Mutation receipt was not finalized");
    }
    const replayed = insertResult.meta.changes === 0;
    const record = recordFromReceipt(row);

    if (row.status === "accepted") {
      if (!record) throw new Error("Accepted mutation is missing its record snapshot");
      return { mutationId: row.mutation_id, status: "accepted", replayed, record };
    }
    return { mutationId: row.mutation_id, status: "conflict", replayed, current: record };
  });
}

export async function pullChanges(
  db: D1Database,
  userId: string,
  cursor: number,
  limit: number,
  collection?: string,
): Promise<PullResponse> {
  const statement =
    collection === undefined
      ? db
          .prepare(
            `SELECT collection, record_id, revision, cursor, deleted, payload, updated_at
            FROM sync_changes
            WHERE user_id = ? AND cursor > ?
            ORDER BY cursor ASC
            LIMIT ?`,
          )
          .bind(userId, cursor, limit + 1)
      : db
          .prepare(
            `SELECT collection, record_id, revision, cursor, deleted, payload, updated_at
            FROM sync_changes
            WHERE user_id = ? AND collection = ? AND cursor > ?
            ORDER BY cursor ASC
            LIMIT ?`,
          )
          .bind(userId, collection, cursor, limit + 1);
  const result = await statement.all<ChangeRow>();

  const hasMore = result.results.length > limit;
  const changes = result.results.slice(0, limit).map(recordFromRow);
  return {
    changes,
    nextCursor: changes.at(-1)?.cursor ?? cursor,
    hasMore,
  };
}
