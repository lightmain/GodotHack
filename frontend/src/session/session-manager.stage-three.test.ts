import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppAction } from "../app/app-state";
import { resetGameState } from "../game-state";
import type { EmscriptenModule } from "../nethack-bridge";
import type { LocalDataStore } from "../storage/local-data";
import type { BackupImportPreview } from "../backup/backup-operations";
import { createDefaultProfile } from "../settings/profile";
import {
  createSessionManager,
  type SessionManagerOptions,
} from "./session-manager";

interface SaveIdentity {
  playerName: string;
  role: string;
  race: string;
  gender: string;
  alignment: string;
}

interface ReadySave {
  path: string;
  modifiedAt: number | null;
  status: "ready";
  identity: SaveIdentity;
}

interface ImportRequest {
  bytes: Uint8Array;
  modifiedAt: number | null;
  overwrite: boolean;
}

interface Conflict {
  status: "conflict";
  path: string;
  existing: { identity: SaveIdentity; modifiedAt: number | null };
  incoming: { identity: SaveIdentity; modifiedAt: number | null };
}

interface StageThreeManager {
  initialize(): Promise<{
    moduleId: string;
    saves: ReadySave[];
    storageAvailable: boolean;
  }>;
  importSave(
    moduleId: string,
    request: ImportRequest,
  ): Promise<Conflict | {
    status: "imported";
    preparation: {
      moduleId: string;
      saves: ReadySave[];
      storageAvailable: boolean;
    };
  }>;
  exportSave(
    moduleId: string,
    path: string,
  ): Promise<{
    bytes: Uint8Array;
    fileName: string;
    mimeType: "application/octet-stream";
  }>;
  clearLocalData(
    moduleId: string,
    localData: LocalDataStore,
    resetLocalState: () => void,
  ): Promise<unknown>;
  importFullBackup(
    moduleId: string,
    preview: BackupImportPreview,
    overwriteFileNames: ReadonlySet<string>,
  ): Promise<{
    imported: number;
    skipped: number;
    failed: number;
    refreshFailed: boolean;
  }>;
}

const adaIdentity: SaveIdentity = {
  playerName: "Ada",
  role: "Wiz",
  race: "Hum",
  gender: "Fem",
  alignment: "Neu",
};
const adaSave: ReadySave = {
  path: "/save/0Ada",
  modifiedAt: 1_700_000_000_000,
  status: "ready",
  identity: adaIdentity,
};

/** Create the minimum idle module needed by Home storage tests. */
function createModule(): EmscriptenModule {
  return {
    ccall: vi.fn(),
    getValue: vi.fn(() => 0),
    setValue: vi.fn(),
    UTF8ToString: vi.fn(() => ""),
    stringToUTF8: vi.fn(),
    _malloc: vi.fn(() => 1024),
    _free: vi.fn(),
    ENV: {},
    FS: {
      analyzePath: vi.fn(() => ({ exists: true })),
      mkdir: vi.fn(),
      mount: vi.fn(),
      readFile: vi.fn(() => new Uint8Array()),
      syncfs: vi.fn((_populate, callback) => callback(null)),
    },
    IDBFS: {},
  };
}

/** Create a manager through its future stage-three public contract. */
function createManager(
  storage: Record<string, unknown>,
  dispatch = vi.fn<(action: AppAction) => void>(),
): { manager: StageThreeManager; dispatch: typeof dispatch } {
  const options: SessionManagerOptions & Record<string, unknown> = {
    createModuleId: () => "module-1",
    createSessionId: () => "session-1",
    createStorageService: () => storage as never,
    dispatch,
    moduleFactory: vi.fn(async () => createModule()),
  };
  return {
    manager: createSessionManager(options) as unknown as StageThreeManager,
    dispatch,
  };
}

beforeEach(() => {
  resetGameState();
});

describe("Home raw save operations", () => {
  it("re-enumerates and dispatches after a successful import", async () => {
    const storage = {
      initialize: vi.fn(async () => true),
      listSaves: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([adaSave]),
      importSave: vi.fn(async () => ({
        status: "imported" as const,
        path: adaSave.path,
      })),
      exportSave: vi.fn(),
      readSave: vi.fn(),
      restoreOriginalSave: vi.fn(),
      deleteSave: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const { manager, dispatch } = createManager(storage);
    await manager.initialize();
    dispatch.mockClear();
    const request: ImportRequest = {
      bytes: Uint8Array.of(0x68),
      modifiedAt: 1_725_000_000_000,
      overwrite: false,
    };

    await expect(manager.importSave("module-1", request)).resolves.toEqual({
      status: "imported",
      preparation: {
        moduleId: "module-1",
        saves: [adaSave],
        storageAvailable: true,
      },
    });

    expect(storage.importSave).toHaveBeenCalledWith(request);
    expect(storage.listSaves).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith({
      type: "HOME_SAVES_UPDATED",
      moduleId: "module-1",
      saves: [adaSave],
    });
  });

  it("returns a conflict without re-enumerating or dispatching", async () => {
    const conflict: Conflict = {
      status: "conflict",
      path: adaSave.path,
      existing: { identity: adaIdentity, modifiedAt: 1_700_000_000_000 },
      incoming: { identity: adaIdentity, modifiedAt: 1_725_000_000_000 },
    };
    const storage = {
      initialize: vi.fn(async () => true),
      listSaves: vi.fn(async () => [adaSave]),
      importSave: vi.fn(async () => conflict),
      exportSave: vi.fn(),
      readSave: vi.fn(),
      restoreOriginalSave: vi.fn(),
      deleteSave: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const { manager, dispatch } = createManager(storage);
    await manager.initialize();
    dispatch.mockClear();

    await expect(manager.importSave("module-1", {
      bytes: Uint8Array.of(0x68),
      modifiedAt: 1_725_000_000_000,
      overwrite: false,
    })).resolves.toEqual(conflict);

    expect(storage.listSaves).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("exports a ready save listed by the current Home module", async () => {
    const bytes = Uint8Array.of(0x68, 0xff);
    const storage = {
      initialize: vi.fn(async () => true),
      listSaves: vi.fn(async () => [adaSave]),
      importSave: vi.fn(),
      exportSave: vi.fn(async () => bytes),
      readSave: vi.fn(),
      restoreOriginalSave: vi.fn(),
      deleteSave: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const { manager } = createManager(storage);
    await manager.initialize();

    await expect(manager.exportSave(
      "module-1",
      adaSave.path,
    )).resolves.toEqual({
      bytes,
      fileName: "Ada.nhsave",
      mimeType: "application/octet-stream",
    });
    await expect(manager.exportSave(
      "module-stale",
      adaSave.path,
    )).rejects.toThrow(/current Home module/i);
    await expect(manager.exportSave(
      "module-1",
      "/save/0Unknown",
    )).rejects.toThrow(/listed/i);
    expect(storage.exportSave).toHaveBeenCalledOnce();
  });

  it("exports unavailable save bytes with a stable hash fallback name", async () => {
    const unavailable = {
      path: "/save/0Broken",
      modifiedAt: null,
      status: "incompatible",
      reason: "fingerprint-mismatch",
    };
    const bytes = Uint8Array.of(0x00);
    const storage = {
      initialize: vi.fn(async () => true),
      listSaves: vi.fn(async () => [unavailable]),
      importSave: vi.fn(),
      exportSave: vi.fn(async () => bytes),
      readSave: vi.fn(),
      restoreOriginalSave: vi.fn(),
      deleteSave: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const { manager } = createManager(storage);
    await manager.initialize();

    await expect(manager.exportSave("module-1", unavailable.path))
      .resolves.toEqual({
        bytes,
        fileName: "blisshack-save-6e340b9cffb3.nhsave",
        mimeType: "application/octet-stream",
      });
  });
});

describe("local data clearing", () => {
  it("restores save and local snapshots when exact-key clearing fails", async () => {
    const snapshot = [{
      path: "/save/0Ada",
      bytes: Uint8Array.of(1, 2, 3),
    }];
    const storage = {
      initialize: vi.fn(async () => true),
      listSaves: vi.fn(async () => [adaSave]),
      clearManagedFiles: vi.fn(async () => snapshot),
      restoreManagedFiles: vi.fn(async () => undefined),
      importSave: vi.fn(),
      exportSave: vi.fn(),
      readSave: vi.fn(),
      restoreOriginalSave: vi.fn(),
      deleteSave: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const localSnapshot = { values: {} };
    const localData: LocalDataStore = {
      snapshot: vi.fn(() => localSnapshot),
      clear: vi.fn(() => {
        throw new Error("localStorage blocked");
      }),
      restore: vi.fn(),
    };
    const resetLocalState = vi.fn();
    const { manager, dispatch } = createManager(storage);
    await manager.initialize();
    dispatch.mockClear();

    await expect(manager.clearLocalData(
      "module-1",
      localData,
      resetLocalState,
    )).rejects.toThrow("localStorage blocked");

    expect(storage.restoreManagedFiles).toHaveBeenCalledWith(snapshot);
    expect(localData.restore).toHaveBeenCalledWith(localSnapshot);
    expect(resetLocalState).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "LOCAL_DATA_CLEARED",
    }));
  });

  it("enters fatal when the storage clear cannot roll back", async () => {
    const failure = new AggregateError([], "storage rollback failed");
    const storage = {
      initialize: vi.fn(async () => true),
      listSaves: vi.fn(async () => [adaSave]),
      clearManagedFiles: vi.fn(async () => {
        throw failure;
      }),
      restoreManagedFiles: vi.fn(async () => undefined),
      importSave: vi.fn(),
      exportSave: vi.fn(),
      readSave: vi.fn(),
      restoreOriginalSave: vi.fn(),
      deleteSave: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const localData: LocalDataStore = {
      snapshot: vi.fn(() => ({ values: {} })),
      clear: vi.fn(),
      restore: vi.fn(),
    };
    const { manager, dispatch } = createManager(storage);
    await manager.initialize();
    dispatch.mockClear();

    await expect(manager.clearLocalData(
      "module-1",
      localData,
      vi.fn(),
    )).rejects.toBe(failure);

    expect(localData.clear).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "MODULE_FATAL_ERROR",
      moduleId: "module-1",
    }));
  });

  it("attempts IDBFS restoration even when local key restoration fails", async () => {
    const snapshot = [{
      path: "/save/0Ada",
      bytes: Uint8Array.of(1),
    }];
    const storage = {
      initialize: vi.fn(async () => true),
      listSaves: vi.fn(async () => [adaSave]),
      clearManagedFiles: vi.fn(async () => snapshot),
      restoreManagedFiles: vi.fn(async () => undefined),
      importSave: vi.fn(),
      exportSave: vi.fn(),
      readSave: vi.fn(),
      restoreOriginalSave: vi.fn(),
      deleteSave: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const localData: LocalDataStore = {
      snapshot: vi.fn(() => ({ values: {} })),
      clear: vi.fn(() => {
        throw new Error("clear failed");
      }),
      restore: vi.fn(() => {
        throw new Error("restore failed");
      }),
    };
    const { manager, dispatch } = createManager(storage);
    await manager.initialize();
    dispatch.mockClear();

    await expect(manager.clearLocalData(
      "module-1",
      localData,
      vi.fn(),
    )).rejects.toThrow("Could not clear or restore local data");

    expect(storage.restoreManagedFiles).toHaveBeenCalledWith(snapshot);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "MODULE_FATAL_ERROR",
      moduleId: "module-1",
    }));
  });
});

describe("full backup import refresh", () => {
  it("preserves per-file results when final save enumeration fails", async () => {
    const storage = {
      initialize: vi.fn(async () => true),
      listSaves: vi.fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("refresh failed")),
      importSave: vi.fn(),
      exportSave: vi.fn(),
      readSave: vi.fn(),
      restoreOriginalSave: vi.fn(),
      deleteSave: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const preview: BackupImportPreview = {
      source: {
        productVersion: "prealpha-3",
        buildId: "test",
        exportedAt: "2026-09-06T12:00:00.000Z",
        profile: createDefaultProfile(),
      },
      entries: [{
        fileName: "0Old",
        bytes: Uint8Array.of(1),
        classification: "incompatible",
        identity: null,
        existing: null,
      }],
    };
    const { manager } = createManager(storage);
    await manager.initialize();

    await expect(manager.importFullBackup(
      "module-1",
      preview,
      new Set(),
    )).resolves.toMatchObject({
      imported: 0,
      skipped: 1,
      failed: 0,
      refreshFailed: true,
    });
  });
});
