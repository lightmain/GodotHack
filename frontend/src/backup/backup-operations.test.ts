import { describe, expect, it, vi } from "vitest";
import { createDefaultProfile } from "../settings/profile";
import type {
  SaveIdentity,
  SaveValidation,
  StorageService,
} from "../storage/storage-service";
import { serializeBackup } from "./backup-file";
import {
  backupPreviewMatches,
  BackupRollbackError,
  importFullBackup,
  previewFullBackup,
  refreshBackupPreview,
} from "./backup-operations";

const ada: SaveIdentity = {
  playerName: "Ada",
  role: "Wiz",
  race: "Hum",
  gender: "Fem",
  alignment: "Neu",
};

describe("full backup operations", () => {
  it("classifies compatible, incompatible, damaged, and conflicting saves", async () => {
    const bytes = await backupBytes([
      { fileName: "0Ada", bytes: Uint8Array.of(1) },
      { fileName: "0Bob", bytes: Uint8Array.of(2) },
      { fileName: "0Cid", bytes: Uint8Array.of(3) },
    ]);
    const storage = storageFake({
      listSaves: vi.fn(async () => [{
        path: "/save/0Ada",
        modifiedAt: 1,
        status: "ready" as const,
        identity: ada,
      }]),
      validateSave: vi.fn(async (value: Uint8Array): Promise<SaveValidation> => {
        if (value[0] === 1) return { status: "ready", identity: ada };
        if (value[0] === 2) {
          return { status: "incompatible", reason: "fingerprint-mismatch" };
        }
        return { status: "damaged", reason: "truncated" };
      }),
    });

    const preview = await previewFullBackup(storage, bytes);

    expect(preview.entries.map((entry) => entry.classification)).toEqual([
      "conflict",
      "incompatible",
      "damaged",
    ]);
  });

  it("imports approved saves and reports independent skipped and failed entries", async () => {
    const storage = storageFake({
      importSave: vi.fn(async ({ bytes, overwrite }) => {
        if (bytes[0] === 4) throw new Error("write failed");
        return {
          status: "imported" as const,
          path: overwrite ? "/save/0Ada" : "/save/0Bob",
        };
      }),
    });
    const preview = {
      source: {
        productVersion: "prealpha-3",
        buildId: "test",
        exportedAt: "2026-09-06T12:00:00.000Z",
        profile: createDefaultProfile(),
      },
      entries: [
        entry("0Ada", 1, "conflict", ada),
        entry("0Bob", 2, "importable", { ...ada, playerName: "Bob" }),
        entry("0Cid", 3, "incompatible", null),
        entry("0Dee", 4, "importable", { ...ada, playerName: "Dee" }),
        entry("0Eve", 5, "damaged", null),
      ],
    };

    const summary = await importFullBackup(
      storage,
      preview,
      new Set(["0Ada"]),
    );

    expect(summary).toMatchObject({ imported: 2, skipped: 1, failed: 2 });
    expect(summary.results.map((result) => result.reason)).toEqual([
      "overwritten",
      "created",
      "incompatible",
      "write-failed",
      "damaged",
    ]);
  });

  it("stops after a transaction rollback failure", async () => {
    const storage = storageFake({
      importSave: vi.fn()
        .mockRejectedValueOnce(new AggregateError([], "rollback failed"))
        .mockResolvedValue({ status: "imported", path: "/save/0Bob" }),
    });
    const preview = {
      source: {
        productVersion: "prealpha-3",
        buildId: "test",
        exportedAt: "2026-09-06T12:00:00.000Z",
        profile: createDefaultProfile(),
      },
      entries: [
        entry("0Ada", 1, "importable", ada),
        entry("0Bob", 2, "importable", { ...ada, playerName: "Bob" }),
      ],
    };

    await expect(importFullBackup(storage, preview, new Set()))
      .rejects.toBeInstanceOf(BackupRollbackError);
    expect(storage.importSave).toHaveBeenCalledOnce();
  });

  it("detects a local conflict created after the reviewed preview", async () => {
    const reviewed = {
      source: {
        productVersion: "prealpha-3",
        buildId: "test",
        exportedAt: "2026-09-06T12:00:00.000Z",
        profile: createDefaultProfile(),
      },
      entries: [entry("0Ada", 1, "importable", ada)],
    };
    const storage = storageFake({
      listSaves: vi.fn(async () => [{
        path: "/save/0Ada",
        modifiedAt: 2,
        status: "ready" as const,
        identity: ada,
      }]),
      validateSave: vi.fn(async () => ({
        status: "ready" as const,
        identity: ada,
      })),
    });

    const current = await refreshBackupPreview(storage, reviewed);

    expect(current.entries[0].classification).toBe("conflict");
    expect(backupPreviewMatches(reviewed, current)).toBe(false);
  });

  it("rejects duplicate parsed player identities before presenting a preview", async () => {
    const bytes = await backupBytes([
      { fileName: "0Ada", bytes: Uint8Array.of(1) },
      { fileName: "0Bob", bytes: Uint8Array.of(2) },
    ]);
    const storage = storageFake({
      validateSave: vi.fn(async () => ({ status: "ready" as const, identity: ada })),
    });

    await expect(previewFullBackup(storage, bytes)).rejects.toThrow(
      "duplicate player identity",
    );
  });
});

function storageFake(
  overrides: Partial<StorageService> = {},
): StorageService {
  return {
    initialize: vi.fn(async () => true),
    refreshFromPersistent: vi.fn(async () => []),
    listSaves: vi.fn(async () => []),
    readSave: vi.fn(async () => new Uint8Array()),
    restoreOriginalSave: vi.fn(async () => undefined),
    deleteSave: vi.fn(async () => undefined),
    exportSave: vi.fn(async () => new Uint8Array()),
    exportAllSaves: vi.fn(async () => []),
    validateSave: vi.fn(async () => ({
      status: "damaged" as const,
      reason: "truncated" as const,
    })),
    importSave: vi.fn(async () => ({
      status: "imported" as const,
      path: "/save/0Ada",
    })),
    clearManagedFiles: vi.fn(async () => []),
    restoreManagedFiles: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
    ...overrides,
  };
}

function entry(
  fileName: string,
  byte: number,
  classification: "importable" | "incompatible" | "damaged" | "conflict",
  identity: SaveIdentity | null,
) {
  return {
    fileName,
    bytes: Uint8Array.of(byte),
    classification,
    identity,
    existing: null,
  };
}

async function backupBytes(
  saves: Array<{ fileName: string; bytes: Uint8Array }>,
): Promise<Uint8Array> {
  return new TextEncoder().encode(await serializeBackup(
    createDefaultProfile(),
    saves,
    "prealpha-3",
    "test",
    new Date("2026-09-06T12:00:00.000Z"),
  ));
}
