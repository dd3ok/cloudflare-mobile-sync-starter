import {
  collectionNameSchema,
  type RetainedTombstoneRequest,
  type RetainedTombstoneResponse,
  recordIdSchema,
  type SyncRecord,
} from "@cloudflare-mobile-sync/api-contract";
import { sha256Hex } from "./crypto";
import { commaSeparated, type Env } from "./env";
import { PublicError } from "./errors";

interface RetainedTombstoneTarget {
  collection: string;
  recordId: string;
  subjectNamespace: string;
  payloadSchema: string;
  payloadVersion: number;
}

interface ReceiptRow {
  mutation_id: string;
  collection: string;
  record_id: string;
  operation: string;
  status: "accepted" | "conflict";
  result_collection: string | null;
  result_record_id: string | null;
  result_revision: number | null;
  result_cursor: number | null;
  result_deleted: number | null;
  result_payload: string | null;
  result_updated_at: string | null;
}

function targets(value: string | undefined): RetainedTombstoneTarget[] {
  if (!value?.trim()) return [];
  const parsed = commaSeparated(value).map((entry) => {
    const fields = entry.split("|");
    if (fields.length !== 5) {
      throw new Error("RETAINED_TOMBSTONE_TARGETS entries must contain five pipe-separated fields");
    }
    const [
      collection = "",
      recordId = "",
      subjectNamespace = "",
      payloadSchema = "",
      versionText = "",
    ] = fields;
    const payloadVersion = Number(versionText);
    if (
      !collectionNameSchema.safeParse(collection).success ||
      !recordIdSchema.safeParse(recordId).success ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(subjectNamespace) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(payloadSchema) ||
      !/^[1-9][0-9]*$/u.test(versionText) ||
      !Number.isSafeInteger(payloadVersion)
    ) {
      throw new Error("RETAINED_TOMBSTONE_TARGETS contains an invalid policy");
    }
    return { collection, recordId, subjectNamespace, payloadSchema, payloadVersion };
  });
  const identities = parsed.map(({ collection, recordId }) => `${collection}\u0000${recordId}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error("RETAINED_TOMBSTONE_TARGETS contains a duplicate target");
  }
  return parsed;
}

function record(row: ReceiptRow): SyncRecord | null {
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
    payload: row.result_payload === null ? null : JSON.parse(row.result_payload),
    updatedAt: row.result_updated_at,
  };
}

export async function retainTombstone(
  env: Pick<Env, "ALLOWED_COLLECTIONS" | "DB" | "RETAINED_TOMBSTONE_TARGETS">,
  userId: string,
  request: RetainedTombstoneRequest,
): Promise<RetainedTombstoneResponse> {
  const target = targets(env.RETAINED_TOMBSTONE_TARGETS).find(
    (candidate) =>
      candidate.collection === request.collection && candidate.recordId === request.recordId,
  );
  if (
    !target ||
    !commaSeparated(env.ALLOWED_COLLECTIONS).includes(target.collection) ||
    target.payloadSchema !== request.tombstone.head.schema ||
    target.payloadVersion !== request.tombstone.v ||
    request.tombstone.accountSlotKey !== (await sha256Hex(`${target.subjectNamespace}:${userId}`))
  ) {
    throw new PublicError(403, "FORBIDDEN", "Retained tombstone target is not allowed");
  }

  const completedAt = new Date().toISOString();
  const payload = JSON.stringify(request.tombstone);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sync_mutations (
         user_id, mutation_id, collection, record_id, operation,
         base_revision, payload, created_at
       ) VALUES (?, ?, ?, ?, 'put', ?, ?, ?)
       ON CONFLICT(user_id, mutation_id) DO NOTHING`,
    ).bind(
      userId,
      request.operationId,
      request.collection,
      request.recordId,
      request.baseRevision,
      payload,
      completedAt,
    ),
    env.DB.prepare(
      `DELETE FROM sync_changes
       WHERE user_id = ? AND collection = ? AND record_id = ?
         AND cursor < COALESCE((
           SELECT cursor FROM sync_records
           WHERE user_id = ? AND collection = ? AND record_id = ?
             AND last_mutation_id = ? AND deleted = 0 AND payload = ?
         ), 0)`,
    ).bind(
      userId,
      request.collection,
      request.recordId,
      userId,
      request.collection,
      request.recordId,
      request.operationId,
      payload,
    ),
    env.DB.prepare(
      `UPDATE sync_mutations
       SET
         result_collection = ?,
         result_record_id = ?,
         result_revision = (SELECT revision FROM sync_records WHERE user_id = ? AND collection = ? AND record_id = ?),
         result_cursor = (SELECT cursor FROM sync_records WHERE user_id = ? AND collection = ? AND record_id = ?),
         result_deleted = 0,
         result_payload = ?,
         result_updated_at = (SELECT updated_at FROM sync_records WHERE user_id = ? AND collection = ? AND record_id = ?)
       WHERE user_id = ? AND collection = ? AND record_id = ?
         AND EXISTS (
           SELECT 1 FROM sync_records
           WHERE user_id = ? AND collection = ? AND record_id = ?
             AND last_mutation_id = ? AND deleted = 0 AND payload = ?
         )`,
    ).bind(
      request.collection,
      request.recordId,
      userId,
      request.collection,
      request.recordId,
      userId,
      request.collection,
      request.recordId,
      payload,
      userId,
      request.collection,
      request.recordId,
      userId,
      request.collection,
      request.recordId,
      userId,
      request.collection,
      request.recordId,
      request.operationId,
      payload,
    ),
    env.DB.prepare(
      `SELECT mutation_id, collection, record_id, operation, status,
         result_collection, result_record_id, result_revision, result_cursor,
         result_deleted, result_payload, result_updated_at
       FROM sync_mutations WHERE user_id = ? AND mutation_id = ?`,
    ).bind(userId, request.operationId),
  ]);
  const row = results[3]?.results[0] as ReceiptRow | undefined;
  if (
    !row ||
    row.collection !== request.collection ||
    row.record_id !== request.recordId ||
    row.operation !== "put"
  ) {
    throw new PublicError(409, "CONFLICT", "Retained tombstone operation ID was already used");
  }
  const snapshot = record(row);
  const replayed = results[0]?.meta.changes === 0;
  if (row.status === "conflict") {
    return { operationId: request.operationId, status: "conflict", replayed, current: snapshot };
  }
  if (!snapshot || snapshot.payload === null) {
    throw new Error("Accepted retained tombstone is missing its record snapshot");
  }
  if (JSON.stringify(snapshot.payload) !== payload) {
    throw new PublicError(409, "CONFLICT", "Retained tombstone operation ID was already used");
  }
  return {
    operationId: request.operationId,
    status: "accepted",
    replayed,
    record: snapshot,
    receipt: { operationId: request.operationId, completedAt: snapshot.updatedAt },
  };
}
