import { describe, expect, it, vi } from "vitest";
import { createDefaultProfile } from "./profile";
import {
  createProfileStore,
  PROFILE_STORAGE_KEY,
  type ProfileStorage,
} from "./profile-store";

function memoryStorage(initial?: string): ProfileStorage & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(PROFILE_STORAGE_KEY, initial);
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

describe("profile store loading", () => {
  it("returns fresh defaults without writing when the key is missing", () => {
    const storage = memoryStorage();
    const store = createProfileStore(storage);

    const result = store.load();

    expect(result).toEqual({
      profile: createDefaultProfile(),
      status: "missing",
    });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("loads and detaches a valid persisted profile", () => {
    const persisted = createDefaultProfile();
    persisted.interface.terminalFontSize = "large";
    const storage = memoryStorage(JSON.stringify(persisted));
    const store = createProfileStore(storage);

    const first = store.load();
    first.profile.interface.terminalFontSize = "small";
    const second = store.load();

    expect(first.status).toBe("loaded");
    expect(second.profile.interface.terminalFontSize).toBe("large");
  });

  it("falls back without overwriting malformed or unsupported data", () => {
    const malformed = memoryStorage("{bad");
    const unsupported = memoryStorage(JSON.stringify({
      ...createDefaultProfile(),
      schemaVersion: 2,
    }));

    expect(createProfileStore(malformed).load().status).toBe("invalid");
    expect(createProfileStore(unsupported).load().status)
      .toBe("unsupported-schema");
    expect(malformed.setItem).not.toHaveBeenCalled();
    expect(unsupported.setItem).not.toHaveBeenCalled();
  });

  it("reports unavailable storage for a null adapter or read failure", () => {
    const throwingStorage: ProfileStorage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(),
    };

    expect(createProfileStore(null).load().status).toBe("unavailable");
    expect(createProfileStore(throwingStorage).load().status)
      .toBe("unavailable");
  });
});

describe("profile store replacement", () => {
  it("validates and replaces the complete record with one setItem", () => {
    const storage = memoryStorage();
    const store = createProfileStore(storage);
    const profile = createDefaultProfile();
    profile.nethack.showTime = true;

    const saved = store.replace(profile);

    expect(saved).toEqual(profile);
    expect(saved).not.toBe(profile);
    expect(storage.setItem).toHaveBeenCalledOnce();
    expect(storage.setItem).toHaveBeenCalledWith(
      PROFILE_STORAGE_KEY,
      JSON.stringify(profile),
    );
  });

  it("rejects an invalid record before touching storage", () => {
    const storage = memoryStorage();
    const store = createProfileStore(storage);
    const profile = createDefaultProfile() as unknown as Record<string, unknown>;
    (profile.interface as Record<string, unknown>).messageHistoryLines = 4;

    expect(() => store.replace(profile as never)).toThrow(/messageHistoryLines/);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("propagates write failures and refuses an unavailable adapter", () => {
    const profile = createDefaultProfile();
    const throwingStorage: ProfileStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new Error("quota exceeded");
      }),
    };

    expect(() => createProfileStore(throwingStorage).replace(profile))
      .toThrow("quota exceeded");
    expect(() => createProfileStore(null).replace(profile))
      .toThrow("unavailable");
  });
});
