import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it } from "vitest";
import { createExpoAccountDeletionJournal } from "./account-deletion-journal";

const testStore = SecureStore as typeof SecureStore & { resetTestStore(): void };
const storagePrefix = "account-deletion-journal-test";
const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("Expo account deletion journal", () => {
  beforeEach(() => testStore.resetTestStore());

  it("persists a validated capability in SecureStore and clears only the same entry", async () => {
    const journal = createExpoAccountDeletionJournal({ storagePrefix });
    const entry = { expectedSubjectId: "account-a", operationId };

    await journal.writePendingAccountDeletion(entry);
    await expect(journal.readPendingAccountDeletion()).resolves.toEqual(entry);

    await journal.clearPendingAccountDeletion({ ...entry, expectedSubjectId: "account-b" });
    await expect(journal.readPendingAccountDeletion()).resolves.toEqual(entry);

    await expect(
      journal.writePendingAccountDeletion({ ...entry, expectedSubjectId: "account-b" }),
    ).rejects.toThrow("Another account deletion is already pending");
    await expect(journal.readPendingAccountDeletion()).resolves.toEqual(entry);

    await journal.clearPendingAccountDeletion(entry);
    await expect(journal.readPendingAccountDeletion()).resolves.toBeNull();
  });

  it("fails closed when persisted journal data is malformed", async () => {
    const journal = createExpoAccountDeletionJournal({ storagePrefix });
    await SecureStore.setItemAsync(`${storagePrefix}_account_deletion`, "{}");

    await expect(journal.readPendingAccountDeletion()).rejects.toThrow();
  });
});
