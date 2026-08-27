import { describe, expect, it } from "vitest";
import {
  jsonPayloadSchema,
  LIMITS,
  nativeGoogleSignInRequestSchema,
  pullQuerySchema,
  pushRequestSchema,
} from "./index";

describe("API contract", () => {
  it("accepts a bounded put mutation", () => {
    const parsed = pushRequestSchema.parse({
      mutations: [
        {
          mutationId: "mutation_1",
          collection: "notes",
          recordId: "note-1",
          baseRevision: 0,
          operation: "put",
          payload: { title: "offline first" },
        },
      ],
    });

    expect(parsed.mutations).toHaveLength(1);
  });

  it("rejects client-controlled user IDs and unknown fields", () => {
    const parsed = pushRequestSchema.safeParse({
      userId: "another-user",
      mutations: [
        {
          mutationId: "mutation_1",
          collection: "notes",
          recordId: "note-1",
          baseRevision: 0,
          operation: "delete",
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects deeply nested JSON", () => {
    let value: unknown = "leaf";
    for (let index = 0; index <= LIMITS.jsonDepth; index += 1) value = [value];

    expect(jsonPayloadSchema.safeParse(value).success).toBe(false);
  });

  it("rejects adversarial JSON depth without overflowing the call stack", () => {
    let value: unknown = "leaf";
    for (let index = 0; index < 5_000; index += 1) value = [value];

    expect(() => jsonPayloadSchema.safeParse(value)).not.toThrow();
    expect(jsonPayloadSchema.safeParse(value).success).toBe(false);
  });

  it("bounds pull pages and validates an optional exact collection", () => {
    expect(pullQuerySchema.parse({})).toEqual({ cursor: 0, limit: LIMITS.pullDefault });
    expect(pullQuerySchema.parse({ collection: "notes-v1" })).toEqual({
      cursor: 0,
      limit: LIMITS.pullDefault,
      collection: "notes-v1",
    });
    expect(pullQuerySchema.safeParse({ cursor: 0, limit: LIMITS.pullMaximum + 1 }).success).toBe(
      false,
    );
    expect(pullQuerySchema.safeParse({ collection: "not allowed" }).success).toBe(false);
  });

  it("preserves the 25-mutation client contract", () => {
    const mutations = Array.from({ length: 26 }, (_, index) => ({
      mutationId: `mutation_${index}`,
      collection: "notes",
      recordId: `note-${index}`,
      baseRevision: 0,
      operation: "delete" as const,
    }));

    expect(pushRequestSchema.safeParse({ mutations: mutations.slice(0, 25) }).success).toBe(true);
    expect(pushRequestSchema.safeParse({ mutations }).success).toBe(false);
  });

  it("accepts only nonce-bound Google ID-token sign-in fields", () => {
    const request = {
      provider: "google",
      idToken: { token: "signed-token", nonce: "a".repeat(64) },
      additionalData: { nativeAttemptId: "b".repeat(64) },
    };
    expect(nativeGoogleSignInRequestSchema.safeParse(request).success).toBe(true);
    expect(
      nativeGoogleSignInRequestSchema.safeParse({
        ...request,
        callbackURL: "com.example.app://auth/callback",
      }).success,
    ).toBe(false);
    expect(
      nativeGoogleSignInRequestSchema.safeParse({
        ...request,
        idToken: { ...request.idToken, accessToken: "must-not-be-stored" },
      }).success,
    ).toBe(false);
  });
});
