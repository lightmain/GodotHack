import {
  createDefaultProfile,
  parseStoredProfile,
  ProfileFormatError,
  validateProfile,
  type BlissHackProfileV1,
} from "./profile";

/** The only browser-local key used for persisted BlissHack settings. */
export const PROFILE_STORAGE_KEY = "blisshack.profile.v1";

/** Minimum localStorage contract used by the profile store. */
export interface ProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type ProfileLoadStatus =
  | "loaded"
  | "missing"
  | "invalid"
  | "unsupported-schema"
  | "unavailable";

export interface ProfileLoadResult {
  profile: BlissHackProfileV1;
  status: ProfileLoadStatus;
}

export interface ProfileStore {
  load(): ProfileLoadResult;
  replace(profile: BlissHackProfileV1): BlissHackProfileV1;
}

/**
 * Create a profile store around an injectable browser storage implementation.
 * A null adapter supports browsers where localStorage access is unavailable.
 */
export function createProfileStore(
  storage: ProfileStorage | null,
): ProfileStore {
  return {
    load(): ProfileLoadResult {
      if (!storage) {
        return defaultResult("unavailable");
      }

      let raw: string | null;
      try {
        raw = storage.getItem(PROFILE_STORAGE_KEY);
      } catch {
        return defaultResult("unavailable");
      }
      if (raw === null) {
        return defaultResult("missing");
      }

      try {
        return {
          profile: parseStoredProfile(raw),
          status: "loaded",
        };
      } catch (error) {
        return defaultResult(
          error instanceof ProfileFormatError
              && error.code === "unsupported-schema"
            ? "unsupported-schema"
            : "invalid",
        );
      }
    },

    replace(profile: BlissHackProfileV1): BlissHackProfileV1 {
      const normalized = validateProfile(profile);
      const serialized = JSON.stringify(normalized);
      if (!storage) {
        throw new Error("Profile storage is unavailable");
      }
      storage.setItem(PROFILE_STORAGE_KEY, serialized);
      return validateProfile(normalized);
    },
  };
}

/** Resolve localStorage without allowing browser policy errors to escape. */
export function browserProfileStorage(): ProfileStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function defaultResult(status: Exclude<ProfileLoadStatus, "loaded">) {
  return {
    profile: createDefaultProfile(),
    status,
  };
}
