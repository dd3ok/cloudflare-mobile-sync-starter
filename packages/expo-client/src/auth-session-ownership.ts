import { expoClient, getCookie, getSetCookie, normalizeCookieName } from "@better-auth/expo/client";

interface SynchronousExpoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface OwnedExpoClientOptions {
  scheme: string;
  storage: SynchronousExpoStorage;
  storagePrefix: string;
}

/**
 * An opaque claim on one locally stored Expo session. Consumers can test or
 * clear the claim, but cannot read the cookie or epoch that establish it.
 */
export interface ExpoSessionOwnership {
  clear(): boolean;
  isCurrent(): boolean;
}

const STORAGE_VALUE_LIMIT = 1_800;
const CHUNK_MARKER = "\u0001ba-chunks:";
const STAGED_CHUNK_MARKER = "\u0001cms-chunks:";
const ownedCookies = new WeakMap<ExpoSessionOwnership, string>();

function parseStagedMarker(value: string): { count: number; generation: 0 | 1 } | null {
  if (!value.startsWith(STAGED_CHUNK_MARKER)) return null;
  const [generationText, countText, ...extra] = value.slice(STAGED_CHUNK_MARKER.length).split(":");
  const generation = Number(generationText);
  const count = Number(countText);
  if (
    extra.length > 0 ||
    (generation !== 0 && generation !== 1) ||
    !Number.isInteger(count) ||
    count < 1
  ) {
    return null;
  }
  return { count, generation };
}

function createCompatibleStorage(storage: SynchronousExpoStorage) {
  return {
    getItem(name: string): string | null {
      const key = normalizeCookieName(name);
      const stored = storage.getItem(key);
      if (stored === null) return null;
      const staged = parseStagedMarker(stored);
      const legacyCount = stored.startsWith(CHUNK_MARKER)
        ? Number(stored.slice(CHUNK_MARKER.length))
        : null;
      const count = staged?.count ?? legacyCount;
      if (count === null) return stored;
      if (!Number.isInteger(count) || count < 1) return null;
      let value = "";
      for (let index = 0; index < count; index += 1) {
        const chunk = storage.getItem(
          staged ? `${key}.${staged.generation}.${index}` : `${key}.${index}`,
        );
        if (chunk === null) return null;
        value += chunk;
      }
      return value;
    },
    setItem(name: string, value: string): void {
      const key = normalizeCookieName(name);
      if (value.length <= STORAGE_VALUE_LIMIT) {
        storage.setItem(key, value);
      } else {
        // Stage into the inactive slot so a partial write leaves the previous
        // marker and all chunks it references intact.
        const current = storage.getItem(key);
        const generation: 0 | 1 = parseStagedMarker(current ?? "")?.generation === 0 ? 1 : 0;
        const count = Math.ceil(value.length / STORAGE_VALUE_LIMIT);
        for (let index = 0; index < count; index += 1) {
          const start = index * STORAGE_VALUE_LIMIT;
          const chunkKey = `${key}.${generation}.${index}`;
          const chunk = value.slice(start, start + STORAGE_VALUE_LIMIT);
          storage.setItem(chunkKey, chunk);
          if (storage.getItem(chunkKey) !== chunk) {
            throw new Error(`Secure storage did not persist ${chunkKey}`);
          }
        }
        storage.setItem(key, `${STAGED_CHUNK_MARKER}${generation}:${count}`);
      }
      if (this.getItem(name) !== value) {
        throw new Error(`Secure storage did not persist ${key}`);
      }
    },
  };
}

function deferSessionSignal(notify: () => void): void {
  queueMicrotask(() => {
    try {
      notify();
    } catch {
      // Observers run after the cookie commit point and cannot reverse it.
    }
  });
}

/** Package-private access for raw authenticated requests in this package. */
export function readOwnedSessionCookie(ownership: ExpoSessionOwnership): string {
  const cookie = ownedCookies.get(ownership);
  if (cookie === undefined) throw new Error("Unknown Expo session ownership token");
  return cookie;
}

/**
 * Extends Better Auth's Expo plugin with synchronous ownership transitions.
 * Cache invalidation happens first and the cookie write is the commit point,
 * so failed cleanup can never expose a replacement account as cleared.
 */
export function ownedExpoClient(options: OwnedExpoClientOptions) {
  const cookieName = `${options.storagePrefix}_cookie`;
  const sessionCacheName = `${options.storagePrefix}_session_data`;
  const storage = createCompatibleStorage(options.storage);
  const readStoredCookie = () => storage.getItem(cookieName) ?? "{}";
  const readCookie = () => getCookie(readStoredCookie()).trim();
  let sessionEpoch = 0;
  const normalizedCookieName = normalizeCookieName(cookieName);
  const cookieChunkPrefix = `${normalizedCookieName}.`;
  let activeApplication: {
    expectedEpoch: number;
    storageError: unknown;
    storageFailed: boolean;
  } | null = null;
  let pendingCookieChunks: { chunks: string[]; expectedEpoch: number } | null = null;

  const staleApplicationError = () =>
    new Error("The shared session changed before the response was applied");
  const assertApplicationCurrent = () => {
    if (activeApplication && activeApplication.expectedEpoch !== sessionEpoch) {
      throw staleApplicationError();
    }
  };
  const recordCookieChange = (before: string) => {
    if (readCookie() === before) return;
    sessionEpoch += 1;
    if (activeApplication) activeApplication.expectedEpoch = sessionEpoch;
  };
  const persist = (write: () => void) => {
    try {
      write();
    } catch (error) {
      if (activeApplication) {
        activeApplication.storageError = error;
        activeApplication.storageFailed = true;
      }
      throw error;
    }
  };

  const plugin = expoClient({
    ...options,
    // A persistent session cache creates a second account-bearing commit point.
    // The cookie remains the single source of truth for account ownership.
    disableCache: true,
    storage: {
      getItem(name) {
        if (normalizeCookieName(name) === normalizedCookieName) return readStoredCookie();
        return options.storage.getItem(name);
      },
      setItem(name, value) {
        const normalizedName = normalizeCookieName(name);
        if (normalizedName === normalizedCookieName && value === "") {
          assertApplicationCurrent();
          pendingCookieChunks = { chunks: [], expectedEpoch: sessionEpoch };
          return;
        }
        if (pendingCookieChunks && normalizedName.startsWith(cookieChunkPrefix)) {
          assertApplicationCurrent();
          if (pendingCookieChunks.expectedEpoch !== sessionEpoch) {
            pendingCookieChunks = null;
            throw staleApplicationError();
          }
          const index = Number(normalizedName.slice(cookieChunkPrefix.length));
          if (Number.isInteger(index) && index >= 0) {
            pendingCookieChunks.chunks[index] = value;
            return;
          }
        }
        if (
          pendingCookieChunks &&
          normalizedName === normalizedCookieName &&
          value.startsWith(CHUNK_MARKER)
        ) {
          const count = Number(value.slice(CHUNK_MARKER.length));
          if (
            !Number.isInteger(count) ||
            count < 1 ||
            pendingCookieChunks.expectedEpoch !== sessionEpoch ||
            pendingCookieChunks.chunks.length < count ||
            Array.from({ length: count }, (_, index) => pendingCookieChunks?.chunks[index]).some(
              (chunk) => typeof chunk !== "string",
            )
          ) {
            throw new Error("Better Auth produced an incomplete session cookie");
          }
          const before = readCookie();
          const preparedCookie = pendingCookieChunks.chunks.slice(0, count).join("");
          persist(() => storage.setItem(cookieName, preparedCookie));
          pendingCookieChunks = null;
          recordCookieChange(before);
          return;
        }
        if (normalizedName === normalizedCookieName) pendingCookieChunks = null;
        const canChangeCookie =
          normalizedName === normalizedCookieName ||
          normalizedName.startsWith(`${normalizedCookieName}.`);
        const before = canChangeCookie ? readCookie() : null;
        if (normalizedName === normalizedCookieName) {
          assertApplicationCurrent();
          persist(() => storage.setItem(cookieName, value));
        } else persist(() => options.storage.setItem(name, value));
        if (before !== null) recordCookieChange(before);
      },
    },
  });
  const requestEpochs = new WeakMap<object, number>();
  const initializedEpoch = Symbol("cloudflare-mobile-sync.initialized-session-epoch");
  let applicationTail = Promise.resolve();
  const applyWhileCurrent = <T>(expectedEpoch: number, apply: () => Promise<T>): Promise<T> => {
    const result = applicationTail.then(async () => {
      if (expectedEpoch !== sessionEpoch) throw staleApplicationError();
      const application = {
        expectedEpoch,
        storageError: undefined as unknown,
        storageFailed: false,
      };
      activeApplication = application;
      try {
        const value = await apply();
        if (application.storageFailed) throw application.storageError;
        if (application.expectedEpoch !== sessionEpoch) throw staleApplicationError();
        return value;
      } finally {
        activeApplication = null;
        pendingCookieChunks = null;
      }
    });
    applicationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const fetchPlugins = plugin.fetchPlugins.map((fetchPlugin) => {
    const wrapped = {
      ...fetchPlugin,
      async init(...args: Parameters<typeof fetchPlugin.init>) {
        const expectedEpoch = sessionEpoch;
        return applyWhileCurrent(expectedEpoch, async () => {
          const result = await fetchPlugin.init(...args);
          const tag = (target: object) =>
            Object.defineProperty(target, initializedEpoch, {
              configurable: true,
              enumerable: true,
              value: sessionEpoch,
              writable: true,
            });
          if (args[1]) tag(args[1]);
          tag(result.options);
          return result;
        });
      },
      hooks: {
        ...fetchPlugin.hooks,
        onRequest(context: { [initializedEpoch]?: number }) {
          const expectedEpoch = context[initializedEpoch];
          if (expectedEpoch === undefined || expectedEpoch !== sessionEpoch) {
            throw staleApplicationError();
          }
          requestEpochs.set(context, expectedEpoch);
        },
        async onSuccess(...args: Parameters<typeof fetchPlugin.hooks.onSuccess>) {
          const expectedEpoch = requestEpochs.get(args[0].request);
          if (expectedEpoch === undefined) throw staleApplicationError();
          await applyWhileCurrent(expectedEpoch, () => fetchPlugin.hooks.onSuccess(...args));
        },
      },
    } as typeof fetchPlugin;
    return wrapped;
  });

  return {
    ...plugin,
    fetchPlugins,
    getActions(...args: Parameters<typeof plugin.getActions>) {
      const store = args[1];
      const sessionAtom = store.atoms.session;
      const observerSafeStore = {
        ...store,
        atoms: {
          ...store.atoms,
          ...(sessionAtom
            ? {
                session: {
                  ...sessionAtom,
                  set(value: Parameters<typeof sessionAtom.set>[0]) {
                    deferSessionSignal(() => sessionAtom.set(value));
                  },
                },
              }
            : {}),
        },
        notify(...notifyArgs: Parameters<typeof store.notify>) {
          deferSessionSignal(() => store.notify(...notifyArgs));
        },
      } as typeof store;
      const actions = plugin.getActions(args[0], observerSafeStore);

      const publishSessionChange = () => {
        if (sessionAtom) {
          deferSessionSignal(() =>
            sessionAtom.set({
              ...sessionAtom.get(),
              data: null,
              error: null,
              isPending: false,
            }),
          );
        }
        deferSessionSignal(() => store.notify("$sessionSignal"));
      };

      const createOwnership = (
        expectedCookie: string,
        expectedEpoch: number,
      ): ExpoSessionOwnership => {
        const isCurrent = () =>
          sessionEpoch === expectedEpoch && actions.getCookie().trim() === expectedCookie;
        const ownership: ExpoSessionOwnership = {
          isCurrent,
          clear() {
            if (!isCurrent()) return false;
            storage.setItem(sessionCacheName, "{}");
            storage.setItem(cookieName, "{}");
            sessionEpoch += 1;
            publishSessionChange();
            return true;
          },
        };
        ownedCookies.set(ownership, expectedCookie);
        return ownership;
      };

      return {
        ...actions,
        captureSessionOwnership(): ExpoSessionOwnership | null {
          const cookie = actions.getCookie().trim();
          return cookie.length === 0 ? null : createOwnership(cookie, sessionEpoch);
        },
        prepareSessionCommit() {
          const expectedCookie = actions.getCookie().trim();
          const expectedEpoch = sessionEpoch;
          const baselineStoredCookie = readStoredCookie();
          const ownership = createOwnership(expectedCookie, expectedEpoch);

          return {
            install(setCookieHeader: string): boolean {
              if (!ownership.isCurrent()) return false;
              const preparedStoredCookie = getSetCookie(setCookieHeader, baselineStoredCookie);
              const preparedCookie = getCookie(preparedStoredCookie).trim();
              if (preparedCookie.length === 0 || preparedCookie === expectedCookie) return false;

              storage.setItem(sessionCacheName, "{}");
              storage.setItem(cookieName, preparedStoredCookie);
              sessionEpoch += 1;
              publishSessionChange();
              return true;
            },
            isCurrent: ownership.isCurrent,
          };
        },
      };
    },
  };
}
