export type PersistenceStatus =
  | "checking"
  | "persistent"
  | "not-persistent"
  | "unsupported"
  | "error";

export type PersistenceRequestResult =
  | "granted"
  | "denied"
  | "unsupported"
  | "error";

/** Browser storage-manager methods used by the persistence controls. */
export interface BrowserStorageManager {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

export interface PersistenceAdapter {
  query(): Promise<Exclude<PersistenceStatus, "checking">>;
  request(): Promise<PersistenceRequestResult>;
}

/**
 * Wrap optional StorageManager methods in deterministic result values.
 * @param storage - browser storage manager or null when unavailable.
 */
export function createPersistenceAdapter(
  storage: BrowserStorageManager | null,
): PersistenceAdapter {
  return {
    async query() {
      if (typeof storage?.persisted !== "function") return "unsupported";
      try {
        return await storage.persisted() ? "persistent" : "not-persistent";
      } catch {
        return "error";
      }
    },
    async request() {
      if (typeof storage?.persist !== "function") return "unsupported";
      try {
        return await storage.persist() ? "granted" : "denied";
      } catch {
        return "error";
      }
    },
  };
}

/** Resolve the current browser StorageManager without assuming support. */
export function browserPersistenceAdapter(): PersistenceAdapter {
  try {
    return createPersistenceAdapter(globalThis.navigator?.storage ?? null);
  } catch {
    return createPersistenceAdapter(null);
  }
}
