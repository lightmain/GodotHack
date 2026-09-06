import { DIAGNOSTIC_STORAGE_KEY } from "../diagnostics/diagnostic-log";
import { PROFILE_STORAGE_KEY } from "../settings/profile-store";

const MANAGED_LOCAL_STORAGE_KEYS = [
  PROFILE_STORAGE_KEY,
  DIAGNOSTIC_STORAGE_KEY,
] as const;

export type ManagedLocalStorageKey =
  (typeof MANAGED_LOCAL_STORAGE_KEYS)[number];

export interface LocalDataSnapshot {
  values: Partial<Record<ManagedLocalStorageKey, string>>;
}

export interface LocalDataStore {
  snapshot(): LocalDataSnapshot;
  clear(): void;
  restore(snapshot: LocalDataSnapshot): void;
}

/** Minimum localStorage API used by the exact-key clear transaction. */
export interface LocalDataStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

/**
 * Create an exact-key local data adapter without exposing broad clear().
 * @param storage - browser localStorage or an injected test replacement.
 */
export function createLocalDataStore(
  storage: LocalDataStorage,
): LocalDataStore {
  return {
    snapshot() {
      const values: LocalDataSnapshot["values"] = {};
      for (const key of MANAGED_LOCAL_STORAGE_KEYS) {
        const value = storage.getItem(key);
        if (value !== null) values[key] = value;
      }
      return { values };
    },
    clear() {
      for (const key of MANAGED_LOCAL_STORAGE_KEYS) storage.removeItem(key);
    },
    restore(snapshot) {
      for (const key of MANAGED_LOCAL_STORAGE_KEYS) {
        const value = snapshot.values[key];
        if (value === undefined) storage.removeItem(key);
        else storage.setItem(key, value);
      }
    },
  };
}

/** Resolve browser localStorage for an explicit user-requested clear. */
export function browserLocalDataStore(): LocalDataStore {
  let storage: Storage;
  try {
    storage = globalThis.localStorage;
  } catch {
    throw new Error("Browser local data storage is unavailable");
  }
  return createLocalDataStore(storage);
}
