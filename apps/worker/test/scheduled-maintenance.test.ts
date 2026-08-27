import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runScheduledMaintenance } from "../src/scheduled-maintenance";

describe("scheduled security-data maintenance", () => {
  it("removes expired native auth attempts and account-deletion receipts without traffic", async () => {
    const now = Date.now();
    const attemptId = "a".repeat(64);
    const operationHash = "b".repeat(64);
    const subjectHash = "c".repeat(64);
    await env.DB.prepare(
      `INSERT INTO native_google_auth_attempt
       (id, application_id, nonce_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(attemptId, "com.example.test", "d".repeat(64), now - 2_000, now - 1_000)
      .run();
    await env.DB.prepare(
      `INSERT INTO account_deletion_receipt
       (operation_hash, subject_hash, result_json, completed_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(operationHash, subjectHash, "{}", new Date(now - 2_000).toISOString(), now - 1_000)
      .run();

    await runScheduledMaintenance(env, now);

    expect(
      await env.DB.prepare(`SELECT id FROM native_google_auth_attempt WHERE id = ?`)
        .bind(attemptId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT operation_hash FROM account_deletion_receipt WHERE operation_hash = ?`,
      )
        .bind(operationHash)
        .first(),
    ).toBeNull();
  });
});
