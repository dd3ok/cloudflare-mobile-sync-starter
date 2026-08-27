import type {
  MutationResult,
  SyncMutation,
  SyncRecord,
} from "@cloudflare-mobile-sync/api-contract";
import type { SyncStore } from "@cloudflare-mobile-sync/client-core";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";

const STORAGE_KEY = "cloudflare-mobile-sync-example.notes.v1";

export interface LocalNote {
  id: string;
  title: string;
  revision: number;
  deleted: boolean;
  pendingMutation?: SyncMutation | undefined;
  conflict?: SyncRecord | null | undefined;
}

export interface NotesSnapshot {
  loaded: boolean;
  loadError: string | null;
  syncOwnerId: string | null;
  cursor: number;
  notes: readonly LocalNote[];
}

interface PersistedNotes {
  version: 1;
  syncOwnerId: string | null;
  cursor: number;
  notes: LocalNote[];
}

function mutationFor(note: LocalNote, operation: "delete" | "put", baseRevision: number) {
  const common = {
    mutationId: Crypto.randomUUID(),
    collection: "notes" as const,
    recordId: note.id,
    baseRevision,
  };
  return operation === "delete"
    ? ({ ...common, operation } satisfies SyncMutation)
    : ({ ...common, operation, payload: { title: note.title } } satisfies SyncMutation);
}

function titleFromRecord(record: SyncRecord): string {
  if (
    record.payload &&
    !Array.isArray(record.payload) &&
    typeof record.payload === "object" &&
    typeof record.payload.title === "string"
  ) {
    return record.payload.title;
  }
  return "Untitled note";
}

function isPersistedNotes(value: unknown): value is PersistedNotes {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedNotes>;
  return (
    candidate.version === 1 &&
    (candidate.syncOwnerId === null || typeof candidate.syncOwnerId === "string") &&
    typeof candidate.cursor === "number" &&
    Array.isArray(candidate.notes)
  );
}

export class AccountMismatchError extends Error {
  constructor() {
    super("Local sync metadata belongs to a different account");
    this.name = "AccountMismatchError";
  }
}

export class LocalNotesStore implements SyncStore {
  private snapshot: NotesSnapshot = {
    loaded: false,
    loadError: null,
    syncOwnerId: null,
    cursor: 0,
    notes: [],
  };
  private readonly listeners = new Set<() => void>();
  private operation = Promise.resolve();

  readonly getSnapshot = (): NotesSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(snapshot: NotesSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private persist(snapshot: NotesSnapshot): Promise<void> {
    const value: PersistedNotes = {
      version: 1,
      syncOwnerId: snapshot.syncOwnerId,
      cursor: snapshot.cursor,
      notes: [...snapshot.notes],
    };
    return AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }

  private update(updater: (current: NotesSnapshot) => NotesSnapshot): Promise<void> {
    const nextOperation = this.operation.then(async () => {
      const next = updater(this.snapshot);
      this.publish(next);
      await this.persist(next);
    });
    this.operation = nextOperation.catch(() => undefined);
    return nextOperation;
  }

  async load(): Promise<void> {
    await this.operation;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) {
        this.publish({ ...this.snapshot, loaded: true });
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isPersistedNotes(parsed)) throw new Error("Unsupported local data format");
      this.publish({
        loaded: true,
        loadError: null,
        syncOwnerId: parsed.syncOwnerId,
        cursor: parsed.cursor,
        notes: parsed.notes,
      });
    } catch {
      this.publish({ ...this.snapshot, loaded: true, loadError: "Local notes could not be read." });
    }
  }

  addNote(title: string): Promise<void> {
    return this.update((current) => {
      const note: LocalNote = {
        id: Crypto.randomUUID(),
        title,
        revision: 0,
        deleted: false,
      };
      if (current.syncOwnerId) note.pendingMutation = mutationFor(note, "put", 0);
      return { ...current, notes: [note, ...current.notes] };
    });
  }

  deleteNote(id: string): Promise<void> {
    return this.update((current) => {
      const note = current.notes.find((item) => item.id === id);
      if (!note) return current;
      if (note.revision === 0) {
        return { ...current, notes: current.notes.filter((item) => item.id !== id) };
      }
      const deleted: LocalNote = {
        ...note,
        deleted: true,
        conflict: undefined,
        pendingMutation: mutationFor(note, "delete", note.revision),
      };
      return {
        ...current,
        notes: current.notes.map((item) => (item.id === id ? deleted : item)),
      };
    });
  }

  prepareForSync(userId: string): Promise<void> {
    return this.update((current) => {
      if (current.syncOwnerId && current.syncOwnerId !== userId) {
        throw new AccountMismatchError();
      }
      if (current.syncOwnerId === userId) return current;
      return {
        ...current,
        syncOwnerId: userId,
        cursor: 0,
        notes: current.notes.map((note) => ({
          ...note,
          revision: 0,
          conflict: undefined,
          pendingMutation: mutationFor(note, "put", 0),
        })),
      };
    });
  }

  detachDeletedAccount(userId: string): Promise<void> {
    return this.update((current) => {
      if (current.syncOwnerId !== userId) return current;
      return {
        ...current,
        syncOwnerId: null,
        cursor: 0,
        notes: current.notes
          .filter((note) => !note.deleted)
          .map((note) => ({
            id: note.id,
            title: note.title,
            revision: 0,
            deleted: false,
          })),
      };
    });
  }

  forceConflict(id: string): Promise<void> {
    return this.update((current) => ({
      ...current,
      notes: current.notes.map((note) => {
        if (note.id !== id || note.revision < 1 || note.pendingMutation || note.conflict) {
          return note;
        }
        const changed = { ...note, title: `${note.title} (stale local edit)` };
        return {
          ...changed,
          pendingMutation: mutationFor(changed, "put", Math.max(0, note.revision - 1)),
        };
      }),
    }));
  }

  keepLocal(id: string): Promise<void> {
    return this.update((current) => ({
      ...current,
      notes: current.notes.map((note) => {
        if (note.id !== id || note.conflict === undefined) return note;
        const baseRevision = note.conflict?.revision ?? 0;
        return {
          ...note,
          conflict: undefined,
          pendingMutation: mutationFor(note, "put", baseRevision),
        };
      }),
    }));
  }

  adoptRemote(id: string): Promise<void> {
    return this.update((current) => {
      const local = current.notes.find((note) => note.id === id);
      if (!local || local.conflict === undefined) return current;
      if (local.conflict === null || local.conflict.deleted) {
        return { ...current, notes: current.notes.filter((note) => note.id !== id) };
      }
      const remote = local.conflict;
      return {
        ...current,
        notes: current.notes.map((note) =>
          note.id === id
            ? {
                id,
                title: titleFromRecord(remote),
                revision: remote.revision,
                deleted: false,
              }
            : note,
        ),
      };
    });
  }

  async getPendingMutations(limit: number): Promise<SyncMutation[]> {
    await this.operation;
    return this.snapshot.notes
      .flatMap((note) => (note.pendingMutation ? [note.pendingMutation] : []))
      .slice(0, limit);
  }

  applyPushResults(results: readonly MutationResult[]): Promise<void> {
    return this.update((current) => {
      const notes = [...current.notes];
      for (const result of results) {
        const index = notes.findIndex(
          (note) => note.pendingMutation?.mutationId === result.mutationId,
        );
        if (index < 0) continue;
        const note = notes[index];
        if (!note) continue;
        if (result.status === "conflict") {
          notes[index] = {
            ...note,
            deleted: false,
            pendingMutation: undefined,
            conflict: result.current,
          };
          continue;
        }
        if (result.record.deleted) {
          notes.splice(index, 1);
          continue;
        }
        notes[index] = {
          id: note.id,
          title: titleFromRecord(result.record),
          revision: result.record.revision,
          deleted: false,
        };
      }
      return { ...current, notes };
    });
  }

  async getPullCursor(): Promise<number> {
    await this.operation;
    return this.snapshot.cursor;
  }

  applyPulledChanges(changes: readonly SyncRecord[], nextCursor: number): Promise<void> {
    return this.update((current) => {
      const notes = [...current.notes];
      for (const record of changes) {
        const index = notes.findIndex((note) => note.id === record.recordId);
        const local = index >= 0 ? notes[index] : undefined;
        if (local?.pendingMutation || local?.conflict !== undefined) {
          notes[index] = { ...local, deleted: false, pendingMutation: undefined, conflict: record };
          continue;
        }
        if (record.deleted) {
          if (index >= 0) notes.splice(index, 1);
          continue;
        }
        const note: LocalNote = {
          id: record.recordId,
          title: titleFromRecord(record),
          revision: record.revision,
          deleted: false,
        };
        if (index >= 0) notes[index] = note;
        else notes.push(note);
      }
      return { ...current, cursor: nextCursor, notes };
    });
  }
}
