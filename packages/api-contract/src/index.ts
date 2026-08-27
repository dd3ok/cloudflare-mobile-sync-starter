import { z } from "zod";

export const API_VERSION = "v1" as const;

export const LIMITS = {
  requestBodyBytes: 256 * 1024,
  payloadBytes: 64 * 1024,
  jsonDepth: 20,
  pushMutations: 25,
  pullDefault: 50,
  pullMaximum: 100,
  collectionLength: 64,
  recordIdLength: 128,
  mutationIdLength: 128,
  nativeApplicationIdLength: 128,
  nativeIdTokenLength: 16_384,
} as const;

export const nativeApplicationIdSchema = z
  .string()
  .min(3)
  .max(LIMITS.nativeApplicationIdLength)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u,
    "Native application ID must use reverse-domain notation",
  );

export const nativeAuthTokenSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/u, "Invalid native authentication token");

export const nativeGoogleAuthAttemptRequestSchema = z
  .object({
    applicationId: nativeApplicationIdSchema,
  })
  .strict();

export const nativeGoogleAuthAttemptResponseSchema = z
  .object({
    attemptId: nativeAuthTokenSchema,
    nonce: nativeAuthTokenSchema,
    webClientId: z
      .string()
      .min(16)
      .max(256)
      .regex(/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u, "Invalid Google Web client ID"),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const nativeGoogleSignInRequestSchema = z
  .object({
    provider: z.literal("google"),
    idToken: z
      .object({
        token: z.string().min(1).max(LIMITS.nativeIdTokenLength),
        nonce: nativeAuthTokenSchema,
      })
      .strict(),
    additionalData: z
      .object({
        nativeAttemptId: nativeAuthTokenSchema,
      })
      .strict(),
  })
  .strict();

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface JsonInspection {
  depth: number;
  valid: boolean;
}

type InspectionEntry =
  | { kind: "value"; value: unknown; parentDepth: number }
  | { kind: "exit"; value: object };

function inspectJsonValue(value: unknown): JsonInspection {
  const stack: InspectionEntry[] = [{ kind: "value", value, parentDepth: 0 }];
  const activeContainers = new Set<object>();
  let depth = 0;

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    if (entry.kind === "exit") {
      activeContainers.delete(entry.value);
      continue;
    }

    const current = entry.value;
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return { depth, valid: false };
      continue;
    }
    if (typeof current !== "object") return { depth, valid: false };

    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      return { depth, valid: false };
    }
    if (activeContainers.has(current)) return { depth, valid: false };

    const currentDepth = entry.parentDepth + 1;
    depth = Math.max(depth, currentDepth);
    activeContainers.add(current);
    stack.push({ kind: "exit", value: current });
    const children = Array.isArray(current) ? current : Object.values(current);
    for (const child of children) {
      stack.push({ kind: "value", value: child, parentDepth: currentDepth });
    }
  }

  return { depth, valid: true };
}

export const jsonValueSchema = z.custom<JsonValue>((value) => inspectJsonValue(value).valid, {
  message: "Expected a JSON value",
});

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export const jsonPayloadSchema = jsonValueSchema.superRefine((value, context) => {
  const inspection = inspectJsonValue(value);
  if (inspection.depth > LIMITS.jsonDepth) {
    context.addIssue({
      code: "custom",
      message: `JSON nesting exceeds ${LIMITS.jsonDepth} levels`,
    });
    return;
  }

  const bytes = utf8ByteLength(JSON.stringify(value));
  if (bytes > LIMITS.payloadBytes) {
    context.addIssue({
      code: "custom",
      message: `JSON payload exceeds ${LIMITS.payloadBytes} bytes`,
    });
  }
});

export const collectionNameSchema = z
  .string()
  .min(1)
  .max(LIMITS.collectionLength)
  .regex(/^[a-z][a-z0-9._-]*$/u, "Invalid collection name");

export const recordIdSchema = z
  .string()
  .min(1)
  .max(LIMITS.recordIdLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u, "Invalid record ID");

export const mutationIdSchema = z
  .string()
  .min(1)
  .max(LIMITS.mutationIdLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u, "Invalid mutation ID");

export const cursorSchema = z.number().int().nonnegative().safe();
export const revisionSchema = z.number().int().nonnegative().safe();

const mutationBaseSchema = z.object({
  mutationId: mutationIdSchema,
  collection: collectionNameSchema,
  recordId: recordIdSchema,
  baseRevision: revisionSchema,
});

export const putMutationSchema = mutationBaseSchema
  .extend({
    operation: z.literal("put"),
    payload: jsonPayloadSchema,
  })
  .strict();

export const deleteMutationSchema = mutationBaseSchema
  .extend({
    operation: z.literal("delete"),
  })
  .strict();

export const syncMutationSchema = z.discriminatedUnion("operation", [
  putMutationSchema,
  deleteMutationSchema,
]);

export const pushRequestSchema = z
  .object({
    mutations: z.array(syncMutationSchema).min(1).max(LIMITS.pushMutations),
  })
  .strict();

const uuidV4Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    "Expected a lowercase UUID v4",
  );

export const retainedLineageTombstoneSchema = z
  .object({
    v: z.number().int().positive().safe(),
    accountSlotKey: z.string().regex(/^[a-f0-9]{64}$/u, "Invalid account slot key"),
    head: z
      .object({
        schema: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u, "Invalid lineage schema"),
        lineageId: uuidV4Schema,
        versionId: uuidV4Schema,
        ancestorVersionIds: z
          .array(uuidV4Schema)
          .max(64)
          .refine((values) => new Set(values).size === values.length, {
            message: "Ancestor version IDs must be unique",
          }),
        writtenAt: z
          .string()
          .datetime({ offset: true })
          .refine(
            (value) => value.endsWith("Z") && new Date(value).toISOString() === value,
            "writtenAt must use canonical UTC ISO format",
          ),
        value: z.object({ state: z.literal("deleted") }).strict(),
      })
      .strict(),
    consent: z.null(),
  })
  .strict();

export const retainedTombstoneRequestSchema = z
  .object({
    operationId: mutationIdSchema,
    collection: collectionNameSchema,
    recordId: recordIdSchema,
    baseRevision: revisionSchema,
    tombstone: retainedLineageTombstoneSchema,
  })
  .strict();

export const syncRecordSchema = z
  .object({
    collection: collectionNameSchema,
    recordId: recordIdSchema,
    revision: z.number().int().positive().safe(),
    cursor: z.number().int().positive().safe(),
    deleted: z.boolean(),
    payload: jsonValueSchema.nullable(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const acceptedMutationResultSchema = z
  .object({
    mutationId: mutationIdSchema,
    status: z.literal("accepted"),
    replayed: z.boolean(),
    record: syncRecordSchema,
  })
  .strict();

export const conflictMutationResultSchema = z
  .object({
    mutationId: mutationIdSchema,
    status: z.literal("conflict"),
    replayed: z.boolean(),
    current: syncRecordSchema.nullable(),
  })
  .strict();

export const mutationResultSchema = z.discriminatedUnion("status", [
  acceptedMutationResultSchema,
  conflictMutationResultSchema,
]);

export const retainedTombstoneResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      operationId: mutationIdSchema,
      status: z.literal("accepted"),
      replayed: z.boolean(),
      record: syncRecordSchema,
      receipt: z
        .object({
          operationId: mutationIdSchema,
          completedAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operationId: mutationIdSchema,
      status: z.literal("conflict"),
      replayed: z.boolean(),
      current: syncRecordSchema.nullable(),
    })
    .strict(),
]);

export const pushResponseSchema = z
  .object({
    results: z.array(mutationResultSchema),
  })
  .strict();

export const pullQuerySchema = z
  .object({
    cursor: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().positive().max(LIMITS.pullMaximum).default(LIMITS.pullDefault),
    collection: collectionNameSchema.optional(),
  })
  .strict();

export const pullResponseSchema = z
  .object({
    changes: z.array(syncRecordSchema),
    nextCursor: cursorSchema,
    hasMore: z.boolean(),
  })
  .strict();

export const accountProviderSchema = z
  .object({
    providerId: z.string().min(1),
    accountId: z.string().min(1),
  })
  .strict();

export const accountResponseSchema = z
  .object({
    user: z
      .object({
        id: z.string().min(1),
        name: z.string(),
        email: z.string().email().nullable(),
        emailIsPlaceholder: z.boolean(),
        image: z.string().url().nullable(),
      })
      .strict(),
    providers: z.array(accountProviderSchema),
  })
  .strict();

export const accountDeletionOperationIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    "Expected a lowercase UUID v4",
  );

export const accountDeletionStatusRequestSchema = z
  .object({
    operationId: accountDeletionOperationIdSchema,
    expectedSubjectId: z.string().min(1).max(256),
  })
  .strict();

export const accountDeletionOutcomeSchema = z
  .object({
    operationId: accountDeletionOperationIdSchema,
    serverDataDeleted: z.literal(true),
    providerRevocations: z.array(
      z
        .object({
          providerId: z.string().min(1).max(64),
          status: z.enum(["confirmed", "unconfirmed"]),
        })
        .strict(),
    ),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const healthResponseSchema = z
  .object({
    ok: z.literal(true),
    version: z.literal(API_VERSION),
  })
  .strict();

export const errorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "VALIDATION_ERROR",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: errorCodeSchema,
        message: z.string().min(1),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type SyncMutation = z.infer<typeof syncMutationSchema>;
export type PutMutation = z.infer<typeof putMutationSchema>;
export type DeleteMutation = z.infer<typeof deleteMutationSchema>;
export type PushRequest = z.infer<typeof pushRequestSchema>;
export type SyncRecord = z.infer<typeof syncRecordSchema>;
export type MutationResult = z.infer<typeof mutationResultSchema>;
export type PushResponse = z.infer<typeof pushResponseSchema>;
export type RetainedLineageTombstone = z.infer<typeof retainedLineageTombstoneSchema>;
export type RetainedTombstoneRequest = z.infer<typeof retainedTombstoneRequestSchema>;
export type RetainedTombstoneResponse = z.infer<typeof retainedTombstoneResponseSchema>;
export type PullQuery = z.infer<typeof pullQuerySchema>;
export type PullResponse = z.infer<typeof pullResponseSchema>;
export type AccountResponse = z.infer<typeof accountResponseSchema>;
export type AccountDeletionStatusRequest = z.infer<typeof accountDeletionStatusRequestSchema>;
export type AccountDeletionOutcome = z.infer<typeof accountDeletionOutcomeSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type NativeGoogleAuthAttemptRequest = z.infer<typeof nativeGoogleAuthAttemptRequestSchema>;
export type NativeGoogleAuthAttemptResponse = z.infer<typeof nativeGoogleAuthAttemptResponseSchema>;
export type NativeGoogleSignInRequest = z.infer<typeof nativeGoogleSignInRequestSchema>;
