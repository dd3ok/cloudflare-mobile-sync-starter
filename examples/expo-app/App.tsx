import {
  type AccountDeletionJournalEntry,
  deleteAccountRecoverably,
  type RecoverableAccountDeletion,
  recoverAccountDeletion,
  SyncApiError,
  syncOnce,
} from "@cloudflare-mobile-sync/client-core";
import { clearExpoSessionForSubject, revokeExpoSession } from "@cloudflare-mobile-sync/expo-client";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  accountDeletionJournal,
  authClient,
  mobileScheme,
  nativeGoogleAuth,
  syncBaseUrl,
  syncClient,
} from "./src/clients";
import { AccountMismatchError, LocalNotesStore } from "./src/local-notes";

const notesStore = new LocalNotesStore();

interface ActionButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "danger" | "primary" | "secondary";
}

function ActionButton({ label, onPress, disabled = false, tone = "secondary" }: ActionButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        tone === "primary" && styles.primaryButton,
        tone === "danger" && styles.dangerButton,
        disabled && styles.disabledButton,
        pressed && !disabled && styles.pressedButton,
      ]}
    >
      <Text
        style={[
          styles.buttonLabel,
          (tone === "primary" || tone === "danger") && styles.invertedButtonLabel,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function AppContent() {
  const snapshot = useSyncExternalStore(
    notesStore.subscribe,
    notesStore.getSnapshot,
    notesStore.getSnapshot,
  );
  const session = authClient.useSession();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingAccountDeletion, setPendingAccountDeletion] =
    useState<AccountDeletionJournalEntry | null>(null);
  const [accountDeletionJournalLoaded, setAccountDeletionJournalLoaded] = useState(false);
  const reconciliationAttempt = useRef<string | null>(null);
  const user = session.data?.user;

  const finishAccountDeletion = useCallback(async (entry: AccountDeletionJournalEntry) => {
    await notesStore.detachDeletedAccount(entry.expectedSubjectId);
    await clearExpoSessionForSubject(
      { authClient, baseUrl: syncBaseUrl, scheme: mobileScheme },
      entry.expectedSubjectId,
      () => nativeGoogleAuth?.clearCredentialState(),
    );
    await accountDeletionJournal.clearPendingAccountDeletion(entry);
    setPendingAccountDeletion(null);
  }, []);

  useEffect(() => {
    void notesStore.load();
    void accountDeletionJournal
      .readPendingAccountDeletion()
      .then((entry) => {
        setPendingAccountDeletion(entry);
        setAccountDeletionJournalLoaded(true);
      })
      .catch((error: unknown) =>
        setMessage(error instanceof Error ? error.message : "Account deletion journal failed."),
      );
  }, []);

  useEffect(() => {
    const pending = pendingAccountDeletion;
    if (
      !snapshot.loaded ||
      snapshot.loadError !== null ||
      !accountDeletionJournalLoaded ||
      session.isPending ||
      busy ||
      !pending
    ) {
      if (!pending) reconciliationAttempt.current = null;
      return;
    }
    const attemptKey = `${pending.operationId}:${user?.id ?? "signed-out"}`;
    if (reconciliationAttempt.current === attemptKey) return;
    reconciliationAttempt.current = attemptKey;

    void (async () => {
      setBusy(true);
      setMessage(null);
      try {
        const recover = async () => {
          try {
            return await recoverAccountDeletion(syncClient, accountDeletionJournal);
          } catch (error) {
            if (
              error instanceof SyncApiError &&
              error.status === 404 &&
              user?.id === pending.expectedSubjectId
            ) {
              return await deleteAccountRecoverably(
                syncClient,
                accountDeletionJournal,
                pending.expectedSubjectId,
                pending.operationId,
              );
            }
            throw error;
          }
        };
        const recovered = await recover();
        if (!recovered) return;
        await finishAccountDeletion(recovered.entry);
        setMessage("Recovered a completed remote account deletion. Local notes were kept.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Account deletion recovery failed.");
      } finally {
        setBusy(false);
      }
    })();
  }, [
    accountDeletionJournalLoaded,
    busy,
    finishAccountDeletion,
    pendingAccountDeletion,
    session.isPending,
    snapshot.loaded,
    snapshot.loadError,
    user?.id,
  ]);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  function addNote(): void {
    const value = title.trim();
    if (!value) {
      setMessage("Enter a note title first.");
      return;
    }
    void run(async () => {
      await notesStore.addNote(value);
      setTitle("");
      setMessage("Saved on this device.");
    });
  }

  function signIn(): void {
    void run(async () => {
      if (!nativeGoogleAuth) throw new Error("Native Google sign-in is not enabled.");
      const prepared = await nativeGoogleAuth.signIn();
      prepared.session.commit();
    });
  }

  async function signOut(): Promise<void> {
    const cleared = await revokeExpoSession({
      authClient,
      baseUrl: syncBaseUrl,
      scheme: mobileScheme,
    });
    if (!cleared) throw new Error("The local session changed during logout.");
    await nativeGoogleAuth?.clearCredentialState();
  }

  function synchronize(): void {
    if (!user) return;
    void run(async () => {
      try {
        await notesStore.prepareForSync(user.id);
      } catch (error) {
        if (error instanceof AccountMismatchError) {
          throw new Error(
            "These local notes are linked to another account. Sign back into that account before syncing.",
          );
        }
        throw error;
      }
      const result = await syncOnce(syncClient, notesStore);
      setMessage(
        `Sync complete: ${result.accepted} accepted, ${result.conflicts} conflicts, ${result.pulled} pulled.`,
      );
    });
  }

  function confirmAccountDeletion(): void {
    if (
      !user ||
      snapshot.loadError !== null ||
      !accountDeletionJournalLoaded ||
      pendingAccountDeletion
    ) {
      return;
    }
    Alert.alert(
      "Delete remote account?",
      "The server account and synchronized data will be removed. Notes stored on this device will remain.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: () => {
            void run(async () => {
              const disconnect = await nativeGoogleAuth?.revokeAccess();
              let completed: RecoverableAccountDeletion;
              try {
                completed = await deleteAccountRecoverably(
                  syncClient,
                  accountDeletionJournal,
                  user.id,
                  Crypto.randomUUID(),
                );
              } catch (error) {
                setPendingAccountDeletion(
                  await accountDeletionJournal.readPendingAccountDeletion(),
                );
                throw error;
              }
              setPendingAccountDeletion(completed.entry);
              const deletion = completed.outcome;
              await finishAccountDeletion(completed.entry);
              const unconfirmed = deletion.providerRevocations
                .filter(({ status }) => status === "unconfirmed")
                .map(({ providerId }) => providerId);
              setMessage(
                disconnect === "failed" || unconfirmed.length > 0
                  ? `Remote account deleted. Google disconnect could not be confirmed; local notes were kept.`
                  : "Remote account deleted. Local notes were kept.",
              );
            });
          },
        },
      ],
    );
  }

  const visibleNotes = snapshot.notes.filter((note) => !note.deleted);
  const pendingCount = snapshot.notes.filter((note) => note.pendingMutation).length;
  const conflictCount = snapshot.notes.filter((note) => note.conflict !== undefined).length;

  if (!snapshot.loaded) {
    return (
      <View style={styles.centeredState}>
        <ActivityIndicator color="#2563eb" />
        <Text style={styles.mutedText}>Loading local notes…</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <Text style={styles.title}>Mobile Sync</Text>
        <Text style={styles.subtitle}>
          Notes work offline first. Sign in only when you want this device to synchronize.
        </Text>
      </View>

      <View style={styles.statusStrip}>
        <View>
          <Text style={styles.statusLabel}>Local records</Text>
          <Text style={styles.statusValue}>{visibleNotes.length}</Text>
        </View>
        <View>
          <Text style={styles.statusLabel}>Pending</Text>
          <Text style={styles.statusValue}>{pendingCount}</Text>
        </View>
        <View>
          <Text style={styles.statusLabel}>Conflicts</Text>
          <Text style={styles.statusValue}>{conflictCount}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>New local note</Text>
        <Text style={styles.label}>Title</Text>
        <TextInput
          accessibilityLabel="Note title"
          editable={!busy}
          onChangeText={setTitle}
          onSubmitEditing={addNote}
          placeholder="Example: Packing list"
          placeholderTextColor="#8b95a5"
          returnKeyType="done"
          style={styles.input}
          value={title}
        />
        <ActionButton
          label="Save on this device"
          onPress={addNote}
          disabled={busy}
          tone="primary"
        />
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeadingRow}>
          <Text style={styles.sectionTitle}>Notes</Text>
          {user ? (
            <ActionButton label="Sync now" onPress={synchronize} disabled={busy} tone="primary" />
          ) : null}
        </View>
        {visibleNotes.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No notes yet</Text>
            <Text style={styles.mutedText}>
              Create one above. A server connection is not required.
            </Text>
          </View>
        ) : (
          visibleNotes.map((note) => (
            <View
              key={note.id}
              style={[styles.note, note.conflict !== undefined && styles.conflictNote]}
            >
              <Text style={styles.noteTitle}>{note.title}</Text>
              <Text style={styles.noteMeta}>
                Revision {note.revision} · {note.pendingMutation ? "waiting to sync" : "saved"}
              </Text>
              {note.conflict !== undefined ? (
                <View style={styles.conflictPanel}>
                  <Text style={styles.conflictTitle}>Review required</Text>
                  <Text style={styles.mutedText}>
                    The server changed after this device's base revision.
                  </Text>
                  <View style={styles.buttonRow}>
                    <ActionButton
                      label="Use server"
                      onPress={() => void run(() => notesStore.adoptRemote(note.id))}
                      disabled={busy}
                    />
                    <ActionButton
                      label="Keep local next sync"
                      onPress={() => void run(() => notesStore.keepLocal(note.id))}
                      disabled={busy}
                    />
                  </View>
                </View>
              ) : (
                <View style={styles.buttonRow}>
                  {note.revision > 0 && !note.pendingMutation ? (
                    <ActionButton
                      label="Make stale edit"
                      onPress={() => void run(() => notesStore.forceConflict(note.id))}
                      disabled={busy}
                    />
                  ) : null}
                  <ActionButton
                    label="Delete note"
                    onPress={() => void run(() => notesStore.deleteNote(note.id))}
                    disabled={busy}
                    tone="danger"
                  />
                </View>
              )}
            </View>
          ))
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Remote account</Text>
        {session.isPending ? (
          <ActivityIndicator color="#2563eb" />
        ) : user ? (
          <>
            <Text style={styles.accountName}>{user.name}</Text>
            <Text style={styles.mutedText}>{user.email}</Text>
            <Text style={styles.accountHint}>Connected to {syncBaseUrl}</Text>
            <View style={styles.buttonRow}>
              <ActionButton label="Sign out" onPress={() => void run(signOut)} disabled={busy} />
              <ActionButton
                label="Delete remote account"
                onPress={confirmAccountDeletion}
                disabled={
                  busy ||
                  snapshot.loadError !== null ||
                  !accountDeletionJournalLoaded ||
                  pendingAccountDeletion !== null
                }
                tone="danger"
              />
            </View>
          </>
        ) : (
          <>
            <Text style={styles.mutedText}>
              Provider credentials stay on the Worker. The app receives only the session cookie.
            </Text>
            {!nativeGoogleAuth ? (
              <Text style={styles.mutedText}>
                No sign-in provider is enabled. Local-only notes remain available.
              </Text>
            ) : (
              <View style={styles.providerList}>
                <ActionButton label="Continue with Google" onPress={signIn} disabled={busy} />
              </View>
            )}
          </>
        )}
      </View>

      {snapshot.loadError ? (
        <Text accessibilityLiveRegion="polite" role="alert" style={styles.errorText}>
          {snapshot.loadError}
        </Text>
      ) : null}
      {message ? (
        <Text accessibilityLiveRegion="polite" style={styles.message}>
          {message}
        </Text>
      ) : null}
      <Text style={styles.footerText}>
        {Platform.OS === "web"
          ? "Web preview verifies layout only; native Google sign-in requires an Android development build."
          : "Google sign-in uses Android Credential Manager and a server-issued one-time nonce."}
      </Text>
    </ScrollView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <AppContent />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#f5f7fa" },
  page: {
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 48,
    gap: 18,
  },
  centeredState: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  header: { gap: 8 },
  title: { color: "#111827", fontSize: 30, lineHeight: 36, fontWeight: "700" },
  subtitle: { color: "#526071", fontSize: 16, lineHeight: 24, maxWidth: 560 },
  statusStrip: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 18,
    backgroundColor: "#111827",
    borderRadius: 16,
  },
  statusLabel: { color: "#aeb8c7", fontSize: 12, lineHeight: 18 },
  statusValue: { color: "#ffffff", fontSize: 22, lineHeight: 28, fontWeight: "700" },
  section: {
    backgroundColor: "#ffffff",
    borderColor: "#dce2ea",
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    gap: 12,
  },
  sectionHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionTitle: { color: "#111827", fontSize: 18, lineHeight: 24, fontWeight: "700" },
  label: { color: "#344054", fontSize: 14, lineHeight: 20, fontWeight: "600" },
  input: {
    minHeight: 48,
    borderColor: "#aeb8c7",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    color: "#111827",
    fontSize: 16,
    backgroundColor: "#ffffff",
  },
  button: {
    minHeight: 46,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderColor: "#aeb8c7",
    borderWidth: 1,
    backgroundColor: "#ffffff",
  },
  primaryButton: { backgroundColor: "#2563eb", borderColor: "#2563eb" },
  dangerButton: { backgroundColor: "#b42318", borderColor: "#b42318" },
  disabledButton: { opacity: 0.45 },
  pressedButton: { opacity: 0.72 },
  buttonLabel: { color: "#27364a", fontSize: 14, lineHeight: 20, fontWeight: "700" },
  invertedButtonLabel: { color: "#ffffff" },
  buttonRow: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  providerList: { gap: 10 },
  emptyState: { paddingVertical: 18, gap: 4 },
  emptyTitle: { color: "#27364a", fontSize: 16, lineHeight: 22, fontWeight: "700" },
  mutedText: { color: "#667085", fontSize: 14, lineHeight: 21 },
  note: { borderTopColor: "#e7ebf0", borderTopWidth: 1, paddingTop: 14, gap: 8 },
  conflictNote: { borderColor: "#f0a000", borderWidth: 1, borderRadius: 12, padding: 14 },
  noteTitle: { color: "#111827", fontSize: 16, lineHeight: 22, fontWeight: "700" },
  noteMeta: { color: "#667085", fontSize: 12, lineHeight: 18 },
  conflictPanel: { gap: 8 },
  conflictTitle: { color: "#8a4b00", fontSize: 14, lineHeight: 20, fontWeight: "700" },
  accountName: { color: "#111827", fontSize: 16, lineHeight: 22, fontWeight: "700" },
  accountHint: { color: "#667085", fontSize: 12, lineHeight: 18 },
  errorText: { color: "#b42318", fontSize: 14, lineHeight: 20, fontWeight: "600" },
  message: {
    color: "#1d3f7a",
    fontSize: 14,
    lineHeight: 20,
    backgroundColor: "#eaf1ff",
    borderRadius: 10,
    padding: 12,
  },
  footerText: { color: "#78869a", fontSize: 12, lineHeight: 18 },
});
