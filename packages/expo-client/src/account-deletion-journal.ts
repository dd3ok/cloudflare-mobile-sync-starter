import { accountDeletionStatusRequestSchema } from "@cloudflare-mobile-sync/api-contract";
import type {
  AccountDeletionJournal,
  AccountDeletionJournalEntry,
} from "@cloudflare-mobile-sync/client-core";
import * as SecureStore from "expo-secure-store";

export interface ExpoAccountDeletionJournalOptions {
  storagePrefix: string;
}

export function createExpoAccountDeletionJournal(
  options: ExpoAccountDeletionJournalOptions,
): AccountDeletionJournal {
  const storageKey = `${options.storagePrefix}_account_deletion`;
  if (!/^[A-Za-z0-9._-]+$/u.test(storageKey)) {
    throw new Error("Account deletion journal storage key is invalid");
  }
  let operation = Promise.resolve();

  async function readStored(): Promise<AccountDeletionJournalEntry | null> {
    const value = await SecureStore.getItemAsync(storageKey);
    if (value === null) return null;
    return accountDeletionStatusRequestSchema.parse(JSON.parse(value));
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = operation.then(task);
    operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    readPendingAccountDeletion() {
      return enqueue(readStored);
    },
    writePendingAccountDeletion(entry) {
      return enqueue(async () => {
        const parsed = accountDeletionStatusRequestSchema.parse(entry);
        const current = await readStored();
        if (
          current &&
          (current.expectedSubjectId !== parsed.expectedSubjectId ||
            current.operationId !== parsed.operationId)
        ) {
          throw new Error("Another account deletion is already pending");
        }
        if (current) return;
        await SecureStore.setItemAsync(storageKey, JSON.stringify(parsed));
      });
    },
    clearPendingAccountDeletion(entry) {
      return enqueue(async () => {
        const current = await readStored();
        if (
          current?.expectedSubjectId !== entry.expectedSubjectId ||
          current.operationId !== entry.operationId
        ) {
          return;
        }
        await SecureStore.deleteItemAsync(storageKey);
      });
    },
  };
}
