import {
  type AccountDeletionOutcome,
  type AccountResponse,
  accountDeletionOutcomeSchema,
} from "@cloudflare-mobile-sync/api-contract";
import { sha256Hex } from "./crypto";

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  sessionCreatedAt: Date;
}

interface AccountRow {
  id: string;
  providerId: string;
  accountId: string;
}

export interface GoogleAccountSubject {
  userId: string;
}

export interface AccountDeletionInternalOutcome {
  outcome: AccountDeletionOutcome;
  subjectHash: string;
}

export interface ProviderDeletionOutcome {
  providerIds: string[];
  providerRevocationFailures: string[];
}

export interface AccountDeletionReceiptInput {
  operationId: string;
  expectedSubjectId: string;
}

export async function getAccount(
  db: D1Database,
  user: AuthenticatedUser,
): Promise<AccountResponse> {
  const accounts = await db
    .prepare(`SELECT id, providerId, accountId FROM account WHERE userId = ? ORDER BY providerId`)
    .bind(user.id)
    .all<AccountRow>();
  const placeholder = user.email.endsWith("@placeholder.invalid");

  return {
    user: {
      id: user.id,
      name: user.name,
      email: placeholder ? null : user.email,
      emailIsPlaceholder: placeholder,
      image: user.image,
    },
    providers: accounts.results.map((account) => ({
      providerId: account.providerId,
      accountId: account.accountId,
    })),
  };
}

export async function deleteAccountData(
  db: D1Database,
  userId: string,
  receipt?: AccountDeletionReceiptInput,
): Promise<ProviderDeletionOutcome> {
  const accounts = await db
    .prepare(`SELECT id, providerId, accountId FROM account WHERE userId = ? ORDER BY providerId`)
    .bind(userId)
    .all<AccountRow>();

  const providerIds = [...new Set(accounts.results.map((account) => account.providerId))].sort();
  // Native ID-token sign-in deliberately stores no Google access or refresh token.
  // Provider disconnect is therefore client-managed and cannot be confirmed here.
  const providerRevocationFailures = providerIds;
  if (receipt) {
    const completedAt = new Date().toISOString();
    const outcome = deletionOutcome(receipt.operationId, completedAt, providerIds, [
      ...providerRevocationFailures,
    ]);
    const receiptInsert = await deletionReceiptInsert(db, receipt, outcome);
    const [stored, deleted] = await db.batch([
      receiptInsert,
      db.prepare(`DELETE FROM user WHERE id = ?`).bind(userId),
    ]);
    if (stored?.meta.changes !== 1 || deleted?.meta.changes !== 1) {
      throw new Error("Account deletion receipt was not committed with user deletion");
    }
  } else {
    const deleted = await db.prepare(`DELETE FROM user WHERE id = ?`).bind(userId).run();
    if (deleted.meta.changes < 1) throw new Error("Account deletion did not delete a user");
  }

  return { providerIds, providerRevocationFailures };
}

const DELETION_RECEIPT_TTL_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

function deletionOutcome(
  operationId: string,
  completedAt: string,
  providerIds: readonly string[],
  failures: readonly string[],
): AccountDeletionOutcome {
  const unconfirmed = new Set(failures);
  return {
    operationId,
    serverDataDeleted: true,
    providerRevocations: providerIds.map((providerId) => ({
      providerId,
      status: unconfirmed.has(providerId) ? "unconfirmed" : "confirmed",
    })),
    completedAt,
  };
}

async function deletionReceiptInsert(
  db: D1Database,
  receipt: AccountDeletionReceiptInput,
  outcome: AccountDeletionOutcome,
): Promise<D1PreparedStatement> {
  return db
    .prepare(
      `INSERT INTO account_deletion_receipt
         (operation_hash, subject_hash, result_json, completed_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      await sha256Hex(receipt.operationId),
      await sha256Hex(receipt.expectedSubjectId),
      JSON.stringify({
        serverDataDeleted: outcome.serverDataDeleted,
        providerRevocations: outcome.providerRevocations,
        completedAt: outcome.completedAt,
      }),
      outcome.completedAt,
      Date.parse(outcome.completedAt) + DELETION_RECEIPT_TTL_MILLISECONDS,
    );
}

export async function storeAccountDeletionReceipt(
  db: D1Database,
  receipt: AccountDeletionReceiptInput,
  providerOutcome: ProviderDeletionOutcome,
): Promise<AccountDeletionOutcome> {
  const completedAt = new Date().toISOString();
  const outcome = deletionOutcome(
    receipt.operationId,
    completedAt,
    providerOutcome.providerIds,
    providerOutcome.providerRevocationFailures,
  );
  const stored = await (await deletionReceiptInsert(db, receipt, outcome)).run();
  if (stored.meta.changes !== 1) throw new Error("Account deletion receipt was not stored");
  return outcome;
}

export async function readAccountDeletionReceipt(
  db: D1Database,
  receipt: AccountDeletionReceiptInput,
): Promise<AccountDeletionOutcome | null> {
  const now = Date.now();
  await pruneExpiredAccountDeletionReceipts(db, now);
  const row = await db
    .prepare(
      `SELECT result_json FROM account_deletion_receipt
       WHERE operation_hash = ? AND subject_hash = ? AND expires_at > ?`,
    )
    .bind(await sha256Hex(receipt.operationId), await sha256Hex(receipt.expectedSubjectId), now)
    .first<{ result_json: string }>();
  if (!row) return null;
  const stored = JSON.parse(row.result_json) as Partial<AccountDeletionOutcome>;
  return accountDeletionOutcomeSchema.parse({
    operationId: receipt.operationId,
    serverDataDeleted: stored.serverDataDeleted,
    providerRevocations: stored.providerRevocations,
    completedAt: stored.completedAt,
  });
}

/** Internal saga lookup. This is intentionally not exposed as a public HTTP capability. */
export async function readAccountDeletionOutcomeByOperation(
  db: D1Database,
  operationId: string,
): Promise<AccountDeletionInternalOutcome | null> {
  const now = Date.now();
  await pruneExpiredAccountDeletionReceipts(db, now);
  const row = await db
    .prepare(
      `SELECT subject_hash, result_json FROM account_deletion_receipt
       WHERE operation_hash = ? AND expires_at > ?`,
    )
    .bind(await sha256Hex(operationId), now)
    .first<{ subject_hash: string; result_json: string }>();
  if (!row) return null;
  const stored = JSON.parse(row.result_json) as Partial<AccountDeletionOutcome>;
  return {
    outcome: accountDeletionOutcomeSchema.parse({
      operationId,
      serverDataDeleted: stored.serverDataDeleted,
      providerRevocations: stored.providerRevocations,
      completedAt: stored.completedAt,
    }),
    subjectHash: row.subject_hash,
  };
}

export async function findGoogleAccountBySubject(
  db: D1Database,
  googleSubject: string,
): Promise<GoogleAccountSubject | null> {
  const rows = await db
    .prepare(
      `SELECT userId FROM account
       WHERE providerId = 'google' AND accountId = ?
       LIMIT 2`,
    )
    .bind(googleSubject)
    .all<{ userId: string }>();
  if (rows.results.length > 1) throw new Error("Google provider identity is not unique");
  const row = rows.results[0];
  return row ? { userId: row.userId } : null;
}

export async function pruneExpiredAccountDeletionReceipts(
  db: D1Database,
  now: number,
): Promise<void> {
  await db.prepare(`DELETE FROM account_deletion_receipt WHERE expires_at <= ?`).bind(now).run();
}
