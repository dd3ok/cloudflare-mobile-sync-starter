import {
  deleteAccountData,
  findGoogleAccountBySubject,
  readAccountDeletionOutcomeByOperation,
} from "./account";
import { constantTimeHexEqual, hmacSha256Hex, randomBase64Url, sha256Hex } from "./crypto";
import { PublicError } from "./errors";
import type { AdminPrincipal, VerifiedGoogleIdentity } from "./request-identity";
import type { RequestPortalConfig } from "./request-portal-config";

const DETAILS_TTL_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const MAX_TEXT_BYTES = 4 * 1_024;
const RECEIPT_SECRET_BYTES = 24;
const RECEIPT_SECRET_LENGTH = 32;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OUTCOME_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export type RequestLocale = "ko" | "en";
export type RequestKind = "account_deletion" | "privacy_request" | "inquiry";
export type PrivacyAction =
  | "access"
  | "correction"
  | "restriction"
  | "withdrawal"
  | "objection"
  | "identity_issue";
export type RequestStatus = "pending" | "completed" | "rejected";

interface OpenCaseBase {
  locale: RequestLocale;
  noticeVersion: string;
  requestText?: string;
}

export type OpenCase =
  | (OpenCaseBase & { kind: "account_deletion" })
  | (OpenCaseBase & { kind: "privacy_request"; privacyAction: PrivacyAction })
  | (OpenCaseBase & { kind: "inquiry" });

export type RequestProof =
  | { kind: "anonymous" }
  | { kind: "google"; identity: VerifiedGoogleIdentity };

export interface PublicCaseView {
  caseId: string;
  kind: RequestKind;
  privacyAction: PrivacyAction | null;
  status: RequestStatus;
  outcomeCode: string | null;
  responseText: string | null;
  locale: RequestLocale;
  createdAt: string;
  closedAt: string | null;
}

export interface OpenedCase extends PublicCaseView {
  receipt: string;
}

export interface ReviewCase {
  caseId: string;
  scope: string;
  kind: RequestKind;
  privacyAction: PrivacyAction | null;
  requestText: string | null;
  locale: RequestLocale;
  noticeVersion: string;
  createdAt: string;
}

export interface ResolveCase {
  caseId: string;
  status: "completed" | "rejected";
  outcomeCode: string;
  responseText: string;
}

export type ResolvedCase = PublicCaseView;

export interface PurgeSummary {
  purgedCases: number;
}

export interface RequestCases {
  open(input: OpenCase, proof: RequestProof): Promise<OpenedCase>;
  view(receipt: string): Promise<PublicCaseView>;
  review(admin: AdminPrincipal): Promise<ReviewCase[]>;
  resolve(command: ResolveCase, admin: AdminPrincipal): Promise<ResolvedCase>;
  purge(now: Date): Promise<PurgeSummary>;
}

export interface RequestCaseDatabases {
  DB: D1Database;
  REQUEST_DB: D1Database;
}

interface RequestCaseRow {
  case_id: string;
  scope: string;
  kind: RequestKind;
  privacy_action: PrivacyAction | null;
  subject_fingerprint: string | null;
  request_text: string | null;
  response_text: string | null;
  status: RequestStatus;
  outcome_code: string | null;
  locale: RequestLocale;
  notice_version: string;
  receipt_digest: string | null;
  receipt_version: number;
  created_at: number;
  closed_at: number | null;
  purge_after: number | null;
  target_account_hash: string | null;
}

interface RequestCasesInternals {
  now?: () => number;
  receiptSecret?: () => string;
}

interface Receipt {
  digest: string;
  token: string;
}

interface PurgeLedgerRow {
  case_id: string;
  purged_at: number;
}

const PURGE_LEDGER_PAGE_SIZE = 25;

/** Reapplies the append-only APP_DB purge ledger before any restored request data is served. */
export async function ensureRequestPurgeLedgerApplied(
  env: RequestCaseDatabases,
  config: Pick<RequestPortalConfig, "requestDbGeneration">,
): Promise<number> {
  let cursorPurgedAt = -1;
  let cursorCaseId = "";
  let purgedCases = 0;
  while (true) {
    const page = await env.DB.prepare(
      `SELECT case_id, purged_at FROM request_purge_ledger
       WHERE request_db_generation = ?
         AND (purged_at > ? OR (purged_at = ? AND case_id > ?))
       ORDER BY purged_at, case_id
       LIMIT ?`,
    )
      .bind(
        config.requestDbGeneration,
        cursorPurgedAt,
        cursorPurgedAt,
        cursorCaseId,
        PURGE_LEDGER_PAGE_SIZE,
      )
      .all<PurgeLedgerRow>();
    if (page.results.length === 0) break;
    const placeholders = page.results.map(() => "?").join(", ");
    const needsReapply = await env.REQUEST_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM request_case WHERE case_id IN (${placeholders}))
         +
         (SELECT COUNT(*) FROM request_evidence
          WHERE case_id IN (${placeholders}) AND details_purged_at IS NULL)
         AS count`,
    )
      .bind(...page.results.map((row) => row.case_id), ...page.results.map((row) => row.case_id))
      .first<number>("count");
    if (needsReapply === 0) {
      const last = page.results.at(-1);
      if (!last) break;
      cursorPurgedAt = last.purged_at;
      cursorCaseId = last.case_id;
      continue;
    }
    const statements: D1PreparedStatement[] = [];
    for (const row of page.results) {
      statements.push(
        env.REQUEST_DB.prepare(
          `UPDATE request_evidence
           SET details_purged_at = COALESCE(details_purged_at, ?)
           WHERE case_id = ?`,
        ).bind(row.purged_at, row.case_id),
        env.REQUEST_DB.prepare(`DELETE FROM request_case WHERE case_id = ?`).bind(row.case_id),
      );
    }
    const results = await env.REQUEST_DB.batch(statements);
    for (let index = 1; index < results.length; index += 2) {
      purgedCases += results[index]?.meta.changes ?? 0;
    }
    const remaining = await env.REQUEST_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM request_case WHERE case_id IN (${placeholders}))
         +
         (SELECT COUNT(*) FROM request_evidence
          WHERE case_id IN (${placeholders}) AND details_purged_at IS NULL)
         AS count`,
    )
      .bind(...page.results.map((row) => row.case_id), ...page.results.map((row) => row.case_id))
      .first<number>("count");
    if (remaining !== 0) throw new Error("Request purge ledger reapplication failed closed");
    const last = page.results.at(-1);
    if (!last) break;
    cursorPurgedAt = last.purged_at;
    cursorCaseId = last.case_id;
  }
  return purgedCases;
}

function assertText(value: string | undefined, required: boolean): string | null {
  const normalized = value?.trim() ?? "";
  if (required && !normalized) {
    throw new PublicError(400, "VALIDATION_ERROR", "Request text is required");
  }
  if (new TextEncoder().encode(normalized).byteLength > MAX_TEXT_BYTES) {
    throw new PublicError(413, "PAYLOAD_TOO_LARGE", "Request text exceeds 4 KiB");
  }
  return normalized || null;
}

function publicView(row: RequestCaseRow): PublicCaseView {
  return {
    caseId: row.case_id,
    kind: row.kind,
    privacyAction: row.privacy_action,
    status: row.status,
    outcomeCode: row.outcome_code,
    responseText: row.response_text,
    locale: row.locale,
    createdAt: new Date(row.created_at).toISOString(),
    closedAt: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
  };
}

function deletionResponse(locale: RequestLocale): string {
  return locale === "ko"
    ? "서비스 계정과 서버 저장 데이터가 삭제되었습니다. Google 연결 해지는 별도로 확인해 주세요."
    : "The service account and server-side data were deleted. Check Google connection removal separately.";
}

function expiredResponse(locale: RequestLocale): string {
  return locale === "ko"
    ? "최대 처리 대기기간이 지나 요청이 종료되었습니다. 필요한 경우 다시 접수해 주세요."
    : "The maximum pending period elapsed. Submit a new request if it is still needed.";
}

async function subjectFingerprint(config: RequestPortalConfig, subject: string): Promise<string> {
  return await hmacSha256Hex(config.subjectHmacKey, `google\0${subject}`);
}

export function createRequestCases(
  env: RequestCaseDatabases,
  config: RequestPortalConfig,
  internals: RequestCasesInternals = {},
): RequestCases {
  const now = internals.now ?? Date.now;
  const receiptSecret = internals.receiptSecret ?? (() => randomBase64Url(RECEIPT_SECRET_BYTES));

  async function issueReceipt(caseId: string): Promise<Receipt> {
    const secret = receiptSecret();
    if (secret.length !== RECEIPT_SECRET_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(secret)) {
      throw new Error("Receipt generator did not return 192 bits in base64url form");
    }
    return { digest: await sha256Hex(secret), token: `${caseId}.${secret}` };
  }

  async function getCase(caseId: string): Promise<RequestCaseRow | null> {
    return await env.REQUEST_DB.prepare(`SELECT * FROM request_case WHERE case_id = ?`)
      .bind(caseId)
      .first<RequestCaseRow>();
  }

  async function insertCase(
    input: OpenCase,
    fingerprint: string | null,
    scope: string,
    text: string | null,
    targetAccountHash: string | null = null,
  ): Promise<{ row: RequestCaseRow; receipt: Receipt }> {
    const caseId = crypto.randomUUID();
    const receipt = await issueReceipt(caseId);
    const createdAt = now();
    const privacyAction = input.kind === "privacy_request" ? input.privacyAction : null;
    await env.REQUEST_DB.batch([
      env.REQUEST_DB.prepare(
        `INSERT INTO request_case
           (case_id, scope, kind, privacy_action, subject_fingerprint, request_text,
             response_text, status, outcome_code, locale, notice_version, receipt_digest,
             receipt_version, created_at, closed_at, purge_after, target_account_hash)
          VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, ?, ?, 1, ?, NULL, NULL, ?)`,
      ).bind(
        caseId,
        scope,
        input.kind,
        privacyAction,
        fingerprint,
        text,
        input.locale,
        input.noticeVersion,
        receipt.digest,
        createdAt,
        targetAccountHash,
      ),
      env.REQUEST_DB.prepare(
        `INSERT INTO request_evidence
           (case_id, kind, created_at, closed_at, outcome_code, details_purged_at,
            retention_policy_version)
         VALUES (?, ?, ?, NULL, NULL, NULL, ?)`,
      ).bind(caseId, input.kind, createdAt, config.evidencePolicyVersion),
    ]);
    const row = await getCase(caseId);
    if (!row) throw new Error("Request case was not committed");
    return { row, receipt };
  }

  async function pendingDeletion(fingerprint: string): Promise<RequestCaseRow | null> {
    return await env.REQUEST_DB.prepare(
      `SELECT * FROM request_case
       WHERE kind = 'account_deletion' AND status = 'pending' AND subject_fingerprint = ?`,
    )
      .bind(fingerprint)
      .first<RequestCaseRow>();
  }

  async function rotatePendingDeletionReceipt(
    row: RequestCaseRow,
    fingerprint: string,
  ): Promise<{ row: RequestCaseRow; receipt: Receipt } | null> {
    const receipt = await issueReceipt(row.case_id);
    const rotated = await env.REQUEST_DB.prepare(
      `UPDATE request_case
       SET receipt_digest = ?, receipt_version = receipt_version + 1
       WHERE case_id = ? AND kind = 'account_deletion' AND status = 'pending'
         AND subject_fingerprint = ? AND receipt_version = ?
       RETURNING *`,
    )
      .bind(receipt.digest, row.case_id, fingerprint, row.receipt_version)
      .first<RequestCaseRow>();
    return rotated ? { row: rotated, receipt } : null;
  }

  async function getOrCreateDeletionCase(
    input: Extract<OpenCase, { kind: "account_deletion" }>,
    identity: VerifiedGoogleIdentity,
    fingerprint: string,
  ): Promise<{ row: RequestCaseRow; receipt: Receipt }> {
    const existing = await pendingDeletion(fingerprint);
    if (existing) {
      const rotated = await rotatePendingDeletionReceipt(existing, fingerprint);
      if (rotated) return rotated;
      throw new PublicError(409, "CONFLICT", "The deletion request changed; try again");
    }
    const account = await findGoogleAccountBySubject(env.DB, identity.subject);
    if (!account) {
      throw new PublicError(404, "NOT_FOUND", "An existing account was not found");
    }
    try {
      return await insertCase(
        input,
        fingerprint,
        config.accountScope,
        null,
        await sha256Hex(account.userId),
      );
    } catch (error) {
      if (!(await pendingDeletion(fingerprint))) throw error;
      throw new PublicError(409, "CONFLICT", "The deletion request changed; try again");
    }
  }

  async function finishDeletion(row: RequestCaseRow): Promise<RequestCaseRow> {
    const closedAt = now();
    const purgeAfter = closedAt + DETAILS_TTL_MILLISECONDS;
    await env.REQUEST_DB.batch([
      env.REQUEST_DB.prepare(
        `UPDATE request_case
         SET status = 'completed', outcome_code = 'account_deleted', response_text = ?,
             closed_at = ?, purge_after = ?
         WHERE case_id = ? AND status = 'pending'`,
      ).bind(deletionResponse(row.locale), closedAt, purgeAfter, row.case_id),
      env.REQUEST_DB.prepare(
        `UPDATE request_evidence
         SET closed_at = COALESCE(closed_at, ?), outcome_code = COALESCE(outcome_code, 'account_deleted')
         WHERE case_id = ?`,
      ).bind(closedAt, row.case_id),
    ]);
    const updated = await getCase(row.case_id);
    if (!updated) throw new Error("Completed request case disappeared");
    return updated;
  }

  async function continueDeletion(
    row: RequestCaseRow,
    identity: VerifiedGoogleIdentity,
  ): Promise<RequestCaseRow> {
    const targetAccountHash = row.target_account_hash;
    // Cases created before the generation-binding migration cannot safely choose a target.
    if (!targetAccountHash) return row;
    let receipt = await readAccountDeletionOutcomeByOperation(env.DB, row.case_id);
    let account = await findGoogleAccountBySubject(env.DB, identity.subject);
    if (receipt) {
      if (receipt.subjectHash !== targetAccountHash) {
        throw new Error("Account deletion receipt does not match the request target");
      }
      const targetStillExists =
        account !== null && (await sha256Hex(account.userId)) === targetAccountHash;
      return targetStillExists ? row : await finishDeletion(row);
    }
    if (!account) return row;
    if ((await sha256Hex(account.userId)) !== targetAccountHash) return row;

    try {
      await deleteAccountData(env.DB, account.userId, {
        operationId: row.case_id,
        expectedSubjectId: account.userId,
      });
    } catch {
      receipt = await readAccountDeletionOutcomeByOperation(env.DB, row.case_id);
      if (!receipt) return row;
    }
    receipt ??= await readAccountDeletionOutcomeByOperation(env.DB, row.case_id);
    if (!receipt?.outcome.serverDataDeleted) return row;
    if (receipt.subjectHash !== targetAccountHash) {
      throw new Error("Account deletion receipt does not match the request target");
    }
    account = await findGoogleAccountBySubject(env.DB, identity.subject);
    const targetStillExists =
      account !== null && (await sha256Hex(account.userId)) === targetAccountHash;
    return targetStillExists ? row : await finishDeletion(row);
  }

  async function open(input: OpenCase, proof: RequestProof): Promise<OpenedCase> {
    if (input.noticeVersion !== config.noticeVersion) {
      throw new PublicError(400, "VALIDATION_ERROR", "The notice version is no longer current");
    }
    if (input.locale !== "ko" && input.locale !== "en") {
      throw new PublicError(400, "VALIDATION_ERROR", "Unsupported locale");
    }

    if (proof.kind === "anonymous") {
      const allowed =
        input.kind === "inquiry" ||
        (input.kind === "privacy_request" &&
          input.privacyAction === "identity_issue" &&
          config.identityIssueEnabled);
      if (!allowed) throw new PublicError(401, "UNAUTHORIZED", "Google verification is required");
      const text = assertText(input.requestText, true);
      const created = await insertCase(
        input,
        null,
        input.kind === "inquiry" ? config.publicScope : config.accountScope,
        text,
      );
      return { ...publicView(created.row), receipt: created.receipt.token };
    }

    if (
      input.kind === "inquiry" ||
      (input.kind === "privacy_request" && input.privacyAction === "identity_issue")
    ) {
      throw new PublicError(400, "VALIDATION_ERROR", "This request uses anonymous verification");
    }
    const fingerprint = await subjectFingerprint(config, proof.identity.subject);
    if (input.kind === "account_deletion") {
      if (!config.accountDeletionEnabled) {
        throw new PublicError(503, "PROVIDER_UNAVAILABLE", "Web account deletion is not released");
      }
      assertText(input.requestText, false);
      const created = await getOrCreateDeletionCase(input, proof.identity, fingerprint);
      const progressed = await continueDeletion(created.row, proof.identity);
      return { ...publicView(progressed), receipt: created.receipt.token };
    }

    if (!(await findGoogleAccountBySubject(env.DB, proof.identity.subject))) {
      throw new PublicError(404, "NOT_FOUND", "An existing account was not found");
    }
    const text = assertText(input.requestText, false);
    const created = await insertCase(input, fingerprint, config.accountScope, text);
    return { ...publicView(created.row), receipt: created.receipt.token };
  }

  async function view(receiptToken: string): Promise<PublicCaseView> {
    const separator = receiptToken.indexOf(".");
    const caseId = receiptToken.slice(0, separator);
    const secret = receiptToken.slice(separator + 1);
    const syntacticallyValid =
      separator > 0 &&
      UUID_V4_PATTERN.test(caseId) &&
      secret.length === RECEIPT_SECRET_LENGTH &&
      /^[A-Za-z0-9_-]+$/u.test(secret);
    const row = await getCase(syntacticallyValid ? caseId : "00000000-0000-4000-8000-000000000000");
    const presentedDigest = await sha256Hex(secret || receiptToken);
    const storedDigest = row?.receipt_digest ?? "0".repeat(64);
    if (!syntacticallyValid || !row || !constantTimeHexEqual(presentedDigest, storedDigest)) {
      throw new PublicError(404, "NOT_FOUND", "Request receipt was not found");
    }
    return publicView(row);
  }

  async function review(_admin: AdminPrincipal): Promise<ReviewCase[]> {
    const rows = await env.REQUEST_DB.prepare(
      `SELECT * FROM request_case WHERE status = 'pending' ORDER BY created_at LIMIT 50`,
    ).all<RequestCaseRow>();
    return rows.results.map((row) => ({
      caseId: row.case_id,
      scope: row.scope,
      kind: row.kind,
      privacyAction: row.privacy_action,
      requestText: row.request_text,
      locale: row.locale,
      noticeVersion: row.notice_version,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async function resolve(command: ResolveCase, _admin: AdminPrincipal): Promise<ResolvedCase> {
    if (!UUID_V4_PATTERN.test(command.caseId)) {
      throw new PublicError(400, "VALIDATION_ERROR", "Invalid case ID");
    }
    if (!OUTCOME_CODE_PATTERN.test(command.outcomeCode)) {
      throw new PublicError(400, "VALIDATION_ERROR", "Invalid outcome code");
    }
    const responseText = assertText(command.responseText, true);
    const current = await getCase(command.caseId);
    if (!current) throw new PublicError(404, "NOT_FOUND", "Request case was not found");
    if (current.kind === "account_deletion") {
      throw new PublicError(
        409,
        "CONFLICT",
        "Account deletion cases can only be completed by deletion reconciliation",
      );
    }
    const closedAt = now();
    const purgeAfter = closedAt + DETAILS_TTL_MILLISECONDS;
    await env.REQUEST_DB.batch([
      env.REQUEST_DB.prepare(
        `UPDATE request_case
         SET status = ?, outcome_code = ?, response_text = ?, closed_at = ?, purge_after = ?
         WHERE case_id = ? AND status = 'pending'`,
      ).bind(
        command.status,
        command.outcomeCode,
        responseText,
        closedAt,
        purgeAfter,
        command.caseId,
      ),
      env.REQUEST_DB.prepare(
        `UPDATE request_evidence
         SET closed_at = COALESCE(closed_at, ?), outcome_code = COALESCE(outcome_code, ?)
         WHERE case_id = ?`,
      ).bind(closedAt, command.outcomeCode, command.caseId),
    ]);
    const row = await getCase(command.caseId);
    if (!row) throw new PublicError(404, "NOT_FOUND", "Request case was not found");
    return publicView(row);
  }

  async function purge(at: Date): Promise<PurgeSummary> {
    const timestamp = at.getTime();
    if (!Number.isFinite(timestamp)) throw new Error("Purge time must be valid");
    let purgedCases = await ensureRequestPurgeLedgerApplied(env, config);
    const pendingCutoff = timestamp - config.pendingMaxAgeMilliseconds;
    const pendingPurgeAfter = timestamp + DETAILS_TTL_MILLISECONDS;
    await env.REQUEST_DB.batch([
      env.REQUEST_DB.prepare(
        `UPDATE request_case
         SET status = 'rejected', outcome_code = 'expired',
             response_text = CASE locale WHEN 'ko' THEN ? ELSE ? END,
             closed_at = ?, purge_after = ?
         WHERE status = 'pending' AND kind != 'account_deletion' AND created_at <= ?`,
      ).bind(
        expiredResponse("ko"),
        expiredResponse("en"),
        timestamp,
        pendingPurgeAfter,
        pendingCutoff,
      ),
      env.REQUEST_DB.prepare(
        `UPDATE request_evidence
         SET closed_at = COALESCE(closed_at, ?), outcome_code = COALESCE(outcome_code, 'expired')
         WHERE case_id IN (
           SELECT case_id FROM request_case
           WHERE status = 'rejected' AND outcome_code = 'expired' AND closed_at = ?
         )`,
      ).bind(timestamp, timestamp),
    ]);
    const due = await env.REQUEST_DB.prepare(
      `SELECT case_id, purge_after AS purged_at FROM request_case
       WHERE status != 'pending' AND purge_after <= ?
       ORDER BY purge_after, case_id`,
    )
      .bind(timestamp)
      .all<PurgeLedgerRow>();
    for (let index = 0; index < due.results.length; index += PURGE_LEDGER_PAGE_SIZE) {
      const page = due.results.slice(index, index + PURGE_LEDGER_PAGE_SIZE);
      await env.DB.batch(
        page.map((row) =>
          env.DB.prepare(
            `INSERT OR IGNORE INTO request_purge_ledger
               (request_db_generation, case_id, purged_at, schema_version)
             VALUES (?, ?, ?, 1)`,
          ).bind(config.requestDbGeneration, row.case_id, timestamp),
        ),
      );
    }
    purgedCases += await ensureRequestPurgeLedgerApplied(env, config);
    return { purgedCases };
  }

  return { open, view, review, resolve, purge };
}
