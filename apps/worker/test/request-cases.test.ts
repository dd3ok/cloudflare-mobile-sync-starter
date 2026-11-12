import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  createRequestCases,
  ensureRequestPurgeLedgerApplied,
  type OpenCase,
  type RequestProof,
} from "../src/request-cases";
import type { RequestPortalConfig } from "../src/request-portal-config";

const config: RequestPortalConfig = {
  origin: "https://requests.example.test",
  organizationName: "Example Studio",
  productName: "Example App",
  publicScope: "organization",
  accountScope: "example-app",
  noticeVersion: "1.0",
  evidencePolicyVersion: "test-policy-1",
  pendingMaxAgeMilliseconds: 30 * 24 * 60 * 60 * 1_000,
  identityIssueEnabled: true,
  accountDeletionEnabled: true,
  requestDbGeneration: "test-generation-1",
  turnstileSiteKey: "1x00000000000000000000AA",
  turnstileSecretKey: "unit-test-only-turnstile-secret-0123456789",
  accessTeamDomain: "https://example.cloudflareaccess.com",
  accessAudience: "test-audience",
  adminEmails: new Set(["admin@example.test"]),
  subjectHmacKey: "unit-test-only-request-subject-key-0123456789",
};

const admin = { email: "admin@example.test" };
const anonymous: RequestProof = { kind: "anonymous" };

async function seedGoogleUser(userId: string, googleSubject: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, NULL, ?, ?)`,
    ).bind(userId, userId, `${userId}@example.test`, now, now),
    env.DB.prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
       VALUES (?, ?, 'google', ?, ?, ?)`,
    ).bind(`${userId}-account`, googleSubject, userId, now, now),
  ]);
}

function receiptGenerator() {
  let index = 0;
  return () => `${"A".repeat(31)}${index++ % 10}`;
}

function inquiry(requestText = "A plain inquiry"): OpenCase {
  return {
    kind: "inquiry",
    locale: "en",
    noticeVersion: config.noticeVersion,
    requestText,
  };
}

beforeEach(async () => {
  await env.REQUEST_DB.batch([
    env.REQUEST_DB.prepare("DELETE FROM request_case"),
    env.REQUEST_DB.prepare("DELETE FROM request_evidence"),
  ]);
});

describe("RequestCases", () => {
  it("stores only a receipt digest and returns a uniform not-found response", async () => {
    const cases = createRequestCases(env, config, { receiptSecret: receiptGenerator() });
    const opened = await cases.open(inquiry("<script>alert(1)</script>"), anonymous);
    const stored = await env.REQUEST_DB.prepare(
      "SELECT receipt_digest, request_text FROM request_case WHERE case_id = ?",
    )
      .bind(opened.caseId)
      .first<{ receipt_digest: string; request_text: string }>();

    expect(stored?.receipt_digest).toHaveLength(64);
    expect(stored?.receipt_digest).not.toContain(opened.receipt);
    expect(stored?.request_text).toBe("<script>alert(1)</script>");
    expect(await cases.view(opened.receipt)).toMatchObject({
      caseId: opened.caseId,
      status: "pending",
      responseText: null,
    });
    await expect(cases.view("not-a-receipt")).rejects.toMatchObject({
      status: 404,
      message: "Request receipt was not found",
    });
    await expect(cases.view(`${opened.caseId}.${"B".repeat(32)}`)).rejects.toMatchObject({
      status: 404,
      message: "Request receipt was not found",
    });
  });

  it("enforces the UTF-8 4 KiB request-text boundary", async () => {
    const cases = createRequestCases(env, config);
    await expect(cases.open(inquiry("가".repeat(1_366)), anonymous)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("keeps one unfinished deletion per subject and rotates its receipt with CAS", async () => {
    const subject = "google-subject-pending";
    await seedGoogleUser("pending-user", subject);
    await env.DB.prepare(
      `CREATE TRIGGER test_block_pending_user_delete
       BEFORE DELETE ON user WHEN OLD.id = 'pending-user'
       BEGIN SELECT RAISE(ABORT, 'blocked for test'); END`,
    ).run();
    const cases = createRequestCases(env, config, { receiptSecret: receiptGenerator() });
    const input: OpenCase = {
      kind: "account_deletion",
      locale: "en",
      noticeVersion: config.noticeVersion,
    };
    const proof: RequestProof = {
      kind: "google",
      identity: { provider: "google", subject },
    };

    const first = await cases.open(input, proof);
    const second = await cases.open(input, proof);

    expect(first.caseId).toBe(second.caseId);
    expect(first.receipt).not.toBe(second.receipt);
    expect(
      await env.REQUEST_DB.prepare(
        `SELECT COUNT(*) AS count FROM request_case
         WHERE kind = 'account_deletion' AND status = 'pending'`,
      ).first("count"),
    ).toBe(1);
    expect(
      await env.REQUEST_DB.prepare("SELECT receipt_version FROM request_case WHERE case_id = ?")
        .bind(first.caseId)
        .first("receipt_version"),
    ).toBe(2);
    await expect(cases.view(first.receipt)).rejects.toMatchObject({ status: 404 });
    expect(await cases.view(second.receipt)).toMatchObject({ status: "pending" });
    await expect(
      cases.resolve(
        {
          caseId: first.caseId,
          status: "completed",
          outcomeCode: "account_deleted",
          responseText: "must be proven by the deletion receipt",
        },
        admin,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("converges after app deletion succeeds but the request DB completion write fails", async () => {
    const subject = "google-subject-recovery";
    await seedGoogleUser("recovery-user", subject);
    await env.REQUEST_DB.prepare(
      `CREATE TRIGGER test_block_request_completion
       BEFORE UPDATE OF status ON request_case WHEN NEW.status = 'completed'
       BEGIN SELECT RAISE(ABORT, 'blocked for test'); END`,
    ).run();
    const cases = createRequestCases(env, config, { receiptSecret: receiptGenerator() });
    const input: OpenCase = {
      kind: "account_deletion",
      locale: "ko",
      noticeVersion: config.noticeVersion,
    };
    const proof: RequestProof = {
      kind: "google",
      identity: { provider: "google", subject },
    };

    await expect(cases.open(input, proof)).rejects.toThrow("blocked for test");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM user WHERE id = 'recovery-user'").first(
        "count",
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM account_deletion_receipt WHERE operation_hash IS NOT NULL",
      ).first("count"),
    ).toBeGreaterThan(0);

    await env.REQUEST_DB.prepare("DROP TRIGGER test_block_request_completion").run();
    const recovered = await cases.open(input, proof);
    expect(recovered.status).toBe("completed");
    expect(recovered.outcomeCode).toBe("account_deleted");
  });

  it("does not delete a newly-created account generation while reconciling an old deletion", async () => {
    const subject = "google-subject-new-generation";
    await seedGoogleUser("old-generation", subject);
    await env.REQUEST_DB.prepare(
      `CREATE TRIGGER test_block_old_generation_completion
       BEFORE UPDATE OF status ON request_case WHEN NEW.status = 'completed'
       BEGIN SELECT RAISE(ABORT, 'blocked for test'); END`,
    ).run();
    const cases = createRequestCases(env, config, { receiptSecret: receiptGenerator() });
    const input: OpenCase = {
      kind: "account_deletion",
      locale: "en",
      noticeVersion: config.noticeVersion,
    };
    const proof: RequestProof = {
      kind: "google",
      identity: { provider: "google", subject },
    };
    await expect(cases.open(input, proof)).rejects.toThrow();
    await env.REQUEST_DB.prepare("DROP TRIGGER test_block_old_generation_completion").run();
    await seedGoogleUser("new-generation", subject);

    const recovered = await cases.open(input, proof);

    expect(recovered.status).toBe("completed");
    expect(
      await env.DB.prepare("SELECT id FROM user WHERE id = 'new-generation'").first("id"),
    ).toBe("new-generation");
  });

  it("does not retarget a pending pre-receipt deletion to a new account generation", async () => {
    const subject = "google-subject-pre-receipt-generation";
    await seedGoogleUser("pre-receipt-old", subject);
    await env.DB.prepare(
      `CREATE TRIGGER test_block_pre_receipt_delete
       BEFORE DELETE ON user WHEN OLD.id = 'pre-receipt-old'
       BEGIN SELECT RAISE(ABORT, 'blocked for test'); END`,
    ).run();
    const cases = createRequestCases(env, config, { receiptSecret: receiptGenerator() });
    const input: OpenCase = {
      kind: "account_deletion",
      locale: "en",
      noticeVersion: config.noticeVersion,
    };
    const proof: RequestProof = {
      kind: "google",
      identity: { provider: "google", subject },
    };

    const pending = await cases.open(input, proof);
    await env.DB.prepare("DROP TRIGGER test_block_pre_receipt_delete").run();
    await env.DB.prepare("DELETE FROM user WHERE id = 'pre-receipt-old'").run();
    await seedGoogleUser("pre-receipt-new", subject);

    const retried = await cases.open(input, proof);

    expect(retried).toMatchObject({ caseId: pending.caseId, status: "pending" });
    expect(
      await env.DB.prepare("SELECT id FROM user WHERE id = 'pre-receipt-new'").first("id"),
    ).toBe("pre-receipt-new");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM account_deletion_receipt WHERE operation_hash = ?",
      )
        .bind(await sha256Hex(pending.caseId))
        .first("count"),
    ).toBe(0);
  });

  it("expires text-bearing pending cases at the configured boundary and reuses terminal purge", async () => {
    let currentTime = Date.parse("2026-08-26T00:00:00.000Z");
    const cases = createRequestCases(env, config, {
      now: () => currentTime,
      receiptSecret: receiptGenerator(),
    });
    const opened = await cases.open(inquiry("unresolved private request"), anonymous);
    const deletionCaseId = crypto.randomUUID();
    await env.REQUEST_DB.batch([
      env.REQUEST_DB.prepare(
        `INSERT INTO request_case
           (case_id, scope, kind, privacy_action, subject_fingerprint, request_text,
            response_text, status, outcome_code, locale, notice_version, receipt_digest,
            receipt_version, created_at, closed_at, purge_after)
         VALUES (?, 'example-app', 'account_deletion', NULL, ?, NULL, NULL, 'pending', NULL,
           'en', '1.0', ?, 1, ?, NULL, NULL)`,
      ).bind(deletionCaseId, "d".repeat(64), "e".repeat(64), currentTime),
      env.REQUEST_DB.prepare(
        `INSERT INTO request_evidence
           (case_id, kind, created_at, closed_at, outcome_code, details_purged_at,
            retention_policy_version)
         VALUES (?, 'account_deletion', ?, NULL, NULL, NULL, ?)`,
      ).bind(deletionCaseId, currentTime, config.evidencePolicyVersion),
    ]);

    currentTime += config.pendingMaxAgeMilliseconds - 1;
    expect(await cases.purge(new Date(currentTime))).toEqual({ purgedCases: 0 });
    expect(await cases.view(opened.receipt)).toMatchObject({ status: "pending" });

    currentTime += 1;
    expect(await cases.purge(new Date(currentTime))).toEqual({ purgedCases: 0 });
    expect(await cases.view(opened.receipt)).toMatchObject({
      status: "rejected",
      outcomeCode: "expired",
    });
    expect(
      await env.REQUEST_DB.prepare("SELECT status FROM request_case WHERE case_id = ?")
        .bind(deletionCaseId)
        .first("status"),
    ).toBe("pending");

    expect(await cases.purge(new Date(currentTime))).toEqual({ purgedCases: 0 });
    const lateResolution = await cases.resolve(
      {
        caseId: opened.caseId,
        status: "completed",
        outcomeCode: "fulfilled",
        responseText: "must not replace expiry",
      },
      admin,
    );
    expect(lateResolution).toMatchObject({ status: "rejected", outcomeCode: "expired" });
    expect(
      await env.REQUEST_DB.prepare(
        "SELECT closed_at, outcome_code FROM request_evidence WHERE case_id = ?",
      )
        .bind(opened.caseId)
        .first<Record<string, unknown>>(),
    ).toMatchObject({ closed_at: currentTime, outcome_code: "expired" });

    currentTime += 7 * 24 * 60 * 60 * 1_000;
    expect(await cases.purge(new Date(currentTime))).toEqual({ purgedCases: 1 });
    await expect(cases.view(opened.receipt)).rejects.toMatchObject({ status: 404 });
  });

  it("resolves once, purges details after seven days, and preserves PII-free evidence", async () => {
    let currentTime = Date.parse("2026-08-26T00:00:00.000Z");
    const cases = createRequestCases(env, config, {
      now: () => currentTime,
      receiptSecret: receiptGenerator(),
    });
    const opened = await cases.open(inquiry("private request body"), anonymous);
    const resolved = await cases.resolve(
      {
        caseId: opened.caseId,
        status: "completed",
        outcomeCode: "fulfilled",
        responseText: "plain response",
      },
      admin,
    );
    expect(resolved).toMatchObject({ status: "completed", outcomeCode: "fulfilled" });

    const repeated = await cases.resolve(
      {
        caseId: opened.caseId,
        status: "rejected",
        outcomeCode: "changed",
        responseText: "must not replace the terminal result",
      },
      admin,
    );
    expect(repeated).toMatchObject({ status: "completed", outcomeCode: "fulfilled" });

    currentTime += 7 * 24 * 60 * 60 * 1_000;
    expect(await cases.purge(new Date(currentTime))).toEqual({ purgedCases: 1 });
    await expect(cases.view(opened.receipt)).rejects.toMatchObject({ status: 404 });
    const evidence = await env.REQUEST_DB.prepare(
      `SELECT case_id, kind, outcome_code, details_purged_at
       FROM request_evidence WHERE case_id = ?`,
    )
      .bind(opened.caseId)
      .first<Record<string, unknown>>();
    expect(evidence).toMatchObject({
      case_id: opened.caseId,
      kind: "inquiry",
      outcome_code: "fulfilled",
      details_purged_at: currentTime,
    });
    expect(JSON.stringify(evidence)).not.toContain("private request body");
    expect(JSON.stringify(evidence)).not.toContain("plain response");
    expect(JSON.stringify(evidence)).not.toContain(await sha256Hex(opened.receipt));

    const ledger = await env.DB.prepare(
      `SELECT request_db_generation, case_id, purged_at
       FROM request_purge_ledger WHERE case_id = ?`,
    )
      .bind(opened.caseId)
      .first<Record<string, unknown>>();
    expect(ledger).toMatchObject({
      request_db_generation: config.requestDbGeneration,
      case_id: opened.caseId,
      purged_at: currentTime,
    });

    await env.REQUEST_DB.prepare(
      `INSERT INTO request_case
         (case_id, scope, kind, privacy_action, subject_fingerprint, request_text,
          response_text, status, outcome_code, locale, notice_version, receipt_digest,
          receipt_version, created_at, closed_at, purge_after)
       VALUES (?, 'organization', 'inquiry', NULL, NULL, 'restored private text',
         'restored response', 'completed', 'fulfilled', 'en', '1.0', ?, 1, ?, ?, ?)`,
    )
      .bind(
        opened.caseId,
        "f".repeat(64),
        currentTime - 8 * 24 * 60 * 60 * 1_000,
        currentTime - 7 * 24 * 60 * 60 * 1_000,
        currentTime,
      )
      .run();
    expect(await ensureRequestPurgeLedgerApplied(env, config)).toBe(1);
    expect(
      await env.REQUEST_DB.prepare("SELECT case_id FROM request_case WHERE case_id = ?")
        .bind(opened.caseId)
        .first(),
    ).toBeNull();
    await expect(
      env.DB.prepare("UPDATE request_purge_ledger SET purged_at = purged_at + 1 WHERE case_id = ?")
        .bind(opened.caseId)
        .run(),
    ).rejects.toThrow("append-only");
  });
});
