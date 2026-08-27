import {
  type AccountDeletionOutcome,
  type AccountResponse,
  accountDeletionOperationIdSchema,
  accountDeletionOutcomeSchema,
  accountDeletionStatusRequestSchema,
  accountResponseSchema,
  type ErrorCode,
  errorEnvelopeSchema,
  type HealthResponse,
  healthResponseSchema,
  LIMITS,
  type MutationResult,
  type PullQuery,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  pullQuerySchema,
  pullResponseSchema,
  pushRequestSchema,
  pushResponseSchema,
  type RetainedTombstoneRequest,
  type RetainedTombstoneResponse,
  retainedTombstoneRequestSchema,
  retainedTombstoneResponseSchema,
  type SyncMutation,
  type SyncRecord,
} from "@cloudflare-mobile-sync/api-contract";

export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener?(
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}

export interface TransportRequest {
  method: "DELETE" | "GET" | "POST";
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  signal?: CancellationSignal;
}

export interface TransportResponse {
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}

export interface HttpTransport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

export interface RetryDependencies {
  sleep(milliseconds: number, signal?: CancellationSignal): Promise<void>;
  random(): number;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMilliseconds: number;
  maximumDelayMilliseconds: number;
}

export interface SyncClientOptions {
  transport: HttpTransport;
  authHeaders?: () => Promise<Readonly<Record<string, string>>>;
  retry: RetryDependencies;
  retryPolicy?: Partial<RetryPolicy>;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMilliseconds: 250,
  maximumDelayMilliseconds: 4_000,
};

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

interface Parser<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

export class SyncApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(status: number, code: ErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "SyncApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export class InvalidServerResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidServerResponseError";
  }
}

export class SyncCancelledError extends Error {
  constructor() {
    super("Operation cancelled");
    this.name = "SyncCancelledError";
  }
}

export interface SyncClient {
  health(signal?: CancellationSignal): Promise<HealthResponse>;
  push(request: PushRequest, signal?: CancellationSignal): Promise<PushResponse>;
  pull(query?: Partial<PullQuery>, signal?: CancellationSignal): Promise<PullResponse>;
  account(signal?: CancellationSignal): Promise<AccountResponse>;
  deleteAccount(
    expectedSubjectId: string,
    operationId: string,
    signal?: CancellationSignal,
  ): Promise<AccountDeletionOutcome>;
  accountDeletionStatus(
    expectedSubjectId: string,
    operationId: string,
    signal?: CancellationSignal,
  ): Promise<AccountDeletionOutcome>;
  retainTombstone(
    request: RetainedTombstoneRequest,
    signal?: CancellationSignal,
  ): Promise<RetainedTombstoneResponse>;
}

export interface SyncStore {
  getPendingMutations(limit: number): Promise<SyncMutation[]>;
  applyPushResults(results: readonly MutationResult[]): Promise<void>;
  getPullCursor(): Promise<number>;
  applyPulledChanges(changes: readonly SyncRecord[], nextCursor: number): Promise<void>;
}

export interface SyncOnceOptions {
  pushBatchSize?: number;
  pullPageSize?: number;
  maximumPullPages?: number;
  signal?: CancellationSignal;
}

export interface SyncOnceResult {
  pushed: number;
  accepted: number;
  conflicts: number;
  pulled: number;
  pages: number;
  nextCursor: number;
  hasMore: boolean;
}

export class SyncPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncPaginationError";
  }
}

export async function syncOnce(
  client: SyncClient,
  store: SyncStore,
  options: SyncOnceOptions = {},
): Promise<SyncOnceResult> {
  const pushBatchSize = options.pushBatchSize ?? LIMITS.pushMutations;
  const pullPageSize = options.pullPageSize ?? LIMITS.pullDefault;
  const maximumPullPages = options.maximumPullPages ?? 20;
  if (
    !Number.isInteger(pushBatchSize) ||
    pushBatchSize < 1 ||
    pushBatchSize > LIMITS.pushMutations ||
    !Number.isInteger(pullPageSize) ||
    pullPageSize < 1 ||
    pullPageSize > LIMITS.pullMaximum ||
    !Number.isInteger(maximumPullPages) ||
    maximumPullPages < 1
  ) {
    throw new Error("Sync limits are outside the API contract");
  }

  assertNotCancelled(options.signal);
  const pending = await store.getPendingMutations(pushBatchSize);
  let accepted = 0;
  let conflicts = 0;
  if (pending.length > 0) {
    const response = await client.push({ mutations: pending }, options.signal);
    accepted = response.results.filter((result) => result.status === "accepted").length;
    conflicts = response.results.length - accepted;
    await store.applyPushResults(response.results);
  }

  let cursor = await store.getPullCursor();
  let pulled = 0;
  let pages = 0;
  let hasMore = false;
  do {
    assertNotCancelled(options.signal);
    const previousCursor = cursor;
    const response = await client.pull({ cursor, limit: pullPageSize }, options.signal);
    if (
      response.nextCursor < previousCursor ||
      (response.hasMore && response.nextCursor === previousCursor)
    ) {
      throw new SyncPaginationError("The server returned a non-advancing pull cursor");
    }
    await store.applyPulledChanges(response.changes, response.nextCursor);
    cursor = response.nextCursor;
    pulled += response.changes.length;
    pages += 1;
    hasMore = response.hasMore;
  } while (hasMore && pages < maximumPullPages);

  return {
    pushed: pending.length,
    accepted,
    conflicts,
    pulled,
    pages,
    nextCursor: cursor,
    hasMore,
  };
}

function assertNotCancelled(signal?: CancellationSignal): void {
  if (signal?.aborted) throw new SyncCancelledError();
}

function retryDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const exponential = Math.min(
    policy.maximumDelayMilliseconds,
    policy.baseDelayMilliseconds * 2 ** (attempt - 1),
  );
  return Math.floor(exponential * (0.5 + random() * 0.5));
}

function parseResponse<T>(parser: Parser<T>, value: unknown): T {
  const parsed = parser.safeParse(value);
  if (!parsed.success) {
    throw new InvalidServerResponseError(`Server response did not match the API contract`);
  }
  return parsed.data;
}

export function createSyncClient(options: SyncClientOptions): SyncClient {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retryPolicy };
  if (policy.maxAttempts < 1) throw new Error("maxAttempts must be at least 1");

  async function request<T>(
    method: TransportRequest["method"],
    path: string,
    parser: Parser<T>,
    body?: unknown,
    signal?: CancellationSignal,
    requestHeaders: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      assertNotCancelled(signal);
      const headers = {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(await options.authHeaders?.()),
        ...requestHeaders,
      };

      try {
        const response = await options.transport.send({
          method,
          path,
          headers,
          ...(body === undefined ? {} : { body }),
          ...(signal === undefined ? {} : { signal }),
        });
        if (response.status >= 200 && response.status < 300) {
          return parseResponse(parser, response.body);
        }

        const error = errorEnvelopeSchema.safeParse(response.body);
        const apiError = error.success
          ? new SyncApiError(
              response.status,
              error.data.error.code,
              error.data.error.message,
              error.data.error.retryable,
            )
          : new SyncApiError(
              response.status,
              "INTERNAL_ERROR",
              "The server returned an invalid error response",
              RETRYABLE_STATUSES.has(response.status),
            );

        if (!apiError.retryable || attempt === policy.maxAttempts) throw apiError;
      } catch (error) {
        if (error instanceof SyncApiError && !error.retryable) throw error;
        if (attempt === policy.maxAttempts) throw error;
      }

      const delay = retryDelay(attempt, policy, options.retry.random);
      await options.retry.sleep(delay, signal);
    }

    throw new Error("Unreachable retry state");
  }

  return {
    health(signal) {
      return request("GET", "/health", healthResponseSchema, undefined, signal);
    },
    async push(value, signal) {
      const body = pushRequestSchema.parse(value);
      return request("POST", "/v1/sync/push", pushResponseSchema, body, signal);
    },
    async pull(value = {}, signal) {
      const query = pullQuerySchema.parse(value);
      const collection =
        query.collection === undefined ? "" : `&collection=${encodeURIComponent(query.collection)}`;
      const search = `?cursor=${query.cursor}&limit=${query.limit}${collection}`;
      return request("GET", `/v1/sync/pull${search}`, pullResponseSchema, undefined, signal);
    },
    async retainTombstone(value, signal) {
      const body = retainedTombstoneRequestSchema.parse(value);
      return request(
        "POST",
        "/v1/sync/retained-tombstone",
        retainedTombstoneResponseSchema,
        body,
        signal,
      );
    },
    account(signal) {
      return request("GET", "/v1/account", accountResponseSchema, undefined, signal);
    },
    async deleteAccount(expectedSubjectId, operationId, signal) {
      if (!expectedSubjectId.trim()) throw new Error("Expected account subject is required");
      const parsedOperationId = accountDeletionOperationIdSchema.parse(operationId);
      return request("DELETE", "/v1/account", accountDeletionOutcomeSchema, undefined, signal, {
        "X-Mobile-Sync-Expected-Subject": expectedSubjectId,
        "X-Mobile-Sync-Deletion-Operation": parsedOperationId,
      });
    },
    async accountDeletionStatus(expectedSubjectId, operationId, signal) {
      const body = accountDeletionStatusRequestSchema.parse({
        expectedSubjectId,
        operationId,
      });
      return request(
        "POST",
        "/v1/account-deletions/status",
        accountDeletionOutcomeSchema,
        body,
        signal,
      );
    },
  };
}
