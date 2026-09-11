import type { DiagnosticArea, DiagnosticEventInput } from "../diagnostics/diagnostic-log";
import { sha256Hex } from "../backup/backup-file";
import {
  exportFullBackup as createFullBackup,
  importFullBackup as importBackupSaves,
  previewFullBackup as createBackupPreview,
  backupPreviewMatches,
  refreshBackupPreview,
  BackupPreviewStaleError,
  BackupRollbackError,
  type BackupImportPreview,
  type BackupImportSummary,
} from "../backup/backup-operations";
import { BUILD_ID, PRODUCT_VERSION } from "../version";
import type { BlissHackProfileV1 } from "../settings/profile";
import type { LocalDataStore } from "../storage/local-data";
import type {
  RawSaveImportRequest,
  RawSaveImportResult,
  SaveListEntry,
  StorageService,
} from "../storage/storage-service";
import {
  GameLockConflictError,
  GameLockRequestError,
  type GameLockLease,
  type GameLockOperation,
} from "../concurrency/game-lock";
import type { EmscriptenModule } from "../nethack-bridge";
import type {
  FullBackupExport,
  FullBackupImportResult,
  HomePreparation,
  HomeSaveImportResult,
  ModuleRecord,
  RawSaveExport,
  SessionManagerContext,
} from "./session-types";

export type PreparedHomeOwner = ModuleRecord & {
  module: NonNullable<ModuleRecord["module"]>;
  storage: StorageService;
  preparation: HomePreparation;
};

interface HomeOperationHooks {
  diagnosticErrorName(error: unknown): string;
  prepareModule(moduleId: string): Promise<HomePreparation>;
  recordDiagnostic(input: DiagnosticEventInput): void;
  reportFatal(
    area: DiagnosticArea,
    event: string,
    error: unknown,
  ): Promise<void>;
}

/** Build Home-owned save, backup, profile, and lock operations. */
export function createHomeOperations(
  context: SessionManagerContext,
  hooks: HomeOperationHooks,
) {
  /**
   * Delete one save owned by the current Home module and refresh its list.
   * @param moduleId - module generation which displayed the save.
   * @param path - exact path previously enumerated for that module.
   * @returns the refreshed Home preparation.
   */
  function deleteSave(
    moduleId: string,
    path: string,
    expected?: SaveListEntry,
  ): Promise<HomePreparation> {
    return runProtectedHomeOperation(
      "raw-save-delete",
      moduleId,
      () => deletePreparedSave(moduleId, path, expected),
      "Another save operation is already active",
    );
  }
  
  /** Refresh the save picker from durable storage under a short lock. */
  function refreshHome(moduleId: string): Promise<HomePreparation> {
    return runProtectedHomeOperation(
      "continue-game",
      moduleId,
      async () => currentHomeOwner(moduleId, "refresh").preparation,
      "Another save operation is already active",
    );
  }
  
  /** Execute a validated Home deletion against its module-bound storage. */
  async function deletePreparedSave(
    moduleId: string,
    path: string,
    expected?: SaveListEntry,
  ): Promise<HomePreparation> {
    const owner = context.currentModule;
    if (
      !owner
      || owner.closed
      || owner.moduleId !== moduleId
      || !owner.storage
      || !owner.preparation
    ) {
      throw new Error("Save deletion does not belong to the current Home module");
    }
    if (owner.session) {
      throw new Error("Cannot delete a save while an active session owns Home");
    }
    const currentSave = owner.preparation.saves.find(
      (save) => save.path === path,
    );
    if (!currentSave) {
      throw new Error("Save path is not listed by the current Home module");
    }
    if (expected && saveListRevision(expected) !== saveListRevision(currentSave)) {
      throw new Error("Save changed in another page; review it before deleting");
    }
  
    let saves: SaveListEntry[];
    try {
      await owner.storage.deleteSave(path);
      assertCurrentHomeModule(owner);
      saves = await owner.storage.listSaves();
      assertCurrentHomeModule(owner);
    } catch (error) {
      hooks.recordDiagnostic({
        level: "error",
        area: "storage",
        event: "storage.delete_failed",
        moduleId,
        detail: { errorName: hooks.diagnosticErrorName(error) },
      });
      throw error;
    }
  
    const preparation = { ...owner.preparation, saves };
    owner.preparation = preparation;
    hooks.recordDiagnostic({
      level: "info",
      area: "storage",
      event: "storage.delete_completed",
      moduleId,
      detail: { saveCount: saves.length },
    });
    context.options.dispatch({
      type: "HOME_SAVES_UPDATED",
      moduleId,
      saves,
    });
    return preparation;
  }
  
  /** Return the current prepared Home owner or reject a stale operation. */
  function currentHomeOwner(
    moduleId: string,
    operation: string,
  ): ModuleRecord & {
    module: EmscriptenModule;
    storage: StorageService;
    preparation: HomePreparation;
  } {
    const owner = context.currentModule;
    if (
      !owner
      || owner.closed
      || owner.moduleId !== moduleId
      || !owner.module
      || !owner.storage
      || !owner.preparation
      || owner.session
    ) {
      throw new Error(
        `Save ${operation} does not belong to the current Home module`,
      );
    }
    return owner as ModuleRecord & {
      module: EmscriptenModule;
      storage: StorageService;
      preparation: HomePreparation;
    };
  }
  
  /** Return the prepared Home owner before a session claims its module. */
  function currentHomeOwnerForSession(): ModuleRecord & {
    module: EmscriptenModule;
    storage: StorageService;
    preparation: HomePreparation;
  } {
    const owner = context.currentModule;
    if (
      !owner
      || owner.closed
      || !owner.module
      || !owner.storage
      || !owner.preparation
      || owner.session
    ) {
      throw new Error("No ready game module is available");
    }
    return owner as ModuleRecord & {
      module: EmscriptenModule;
      storage: StorageService;
      preparation: HomePreparation;
    };
  }
  
  /** Refresh a prepared module from durable IDBFS while its lock is held. */
  async function refreshHomeStorage(
    owner: ModuleRecord & {
      storage: StorageService;
      preparation: HomePreparation;
    },
  ): Promise<void> {
    if (!owner.preparation.storageAvailable) return;
    const saves = await owner.storage.refreshFromPersistent();
    assertCurrentHomeModule(owner);
    owner.preparation = { ...owner.preparation, saves };
    context.options.dispatch({
      type: "HOME_SAVES_UPDATED",
      moduleId: owner.moduleId,
      saves,
    });
  }
  
  /**
   * Validate and import raw bytes for the current Home module.
   * @param moduleId - module generation which opened the file picker.
   * @param request - raw bytes, file timestamp, and explicit overwrite choice.
   */
  function importSave(
    moduleId: string,
    request: RawSaveImportRequest,
  ): Promise<HomeSaveImportResult> {
    return runProtectedHomeOperation(
      "raw-save-import",
      moduleId,
      () => importPreparedSave(moduleId, request),
      "Another save operation is already active",
    );
  }
  
  /** Import one file and refresh Home only after durable persistence. */
  async function importPreparedSave(
    moduleId: string,
    request: RawSaveImportRequest,
  ): Promise<HomeSaveImportResult> {
    const owner = currentHomeOwner(moduleId, "import");
    if (!owner.preparation.storageAvailable) {
      throw new Error("Persistent storage is unavailable");
    }
  
    let result: RawSaveImportResult;
    try {
      result = await owner.storage.importSave(request);
    } catch (error) {
      hooks.recordDiagnostic({
        level: "warning",
        area: "storage",
        event: "storage.import_rejected",
        moduleId,
        detail: { errorName: hooks.diagnosticErrorName(error) },
      });
      throw error;
    }
    assertCurrentHomeModule(owner);
    if (result.status === "conflict") {
      hooks.recordDiagnostic({
        level: "info",
        area: "storage",
        event: "storage.import_conflict",
        moduleId,
      });
      return result;
    }
  
    const saves = await owner.storage.listSaves();
    assertCurrentHomeModule(owner);
    const preparation = { ...owner.preparation, saves };
    owner.preparation = preparation;
    hooks.recordDiagnostic({
      level: "info",
      area: "storage",
      event: "storage.import_completed",
      moduleId,
      detail: { saveCount: saves.length },
    });
    context.options.dispatch({
      type: "HOME_SAVES_UPDATED",
      moduleId,
      saves,
    });
    return { status: "imported", preparation };
  }
  
  /**
   * Read one listed formal save for a browser download.
   * @param moduleId - module generation which displayed the save.
   * @param path - exact path selected from that module's list.
   */
  function exportSave(
    moduleId: string,
    path: string,
  ): Promise<RawSaveExport> {
    return runProtectedHomeOperation(
      "raw-save-export",
      moduleId,
      () => exportPreparedSave(moduleId, path),
      "Another save operation is already active",
    );
  }
  
  /** Build a raw download without modifying or flushing the save. */
  async function exportPreparedSave(
    moduleId: string,
    path: string,
  ): Promise<RawSaveExport> {
    const owner = currentHomeOwner(moduleId, "export");
    const listedSave = owner.preparation.saves.find(
      (save) => save.path === path,
    );
    if (!listedSave) {
      throw new Error("Save is not listed by the current Home module");
    }
    let bytes: Uint8Array;
    let fileName: string;
    try {
      bytes = await owner.storage.exportSave(path);
      assertCurrentHomeModule(owner);
      fileName = listedSave.status === "ready"
        ? `${safeDownloadName(listedSave.identity.playerName)}.nhsave`
        : `blisshack-save-${(await sha256Hex(bytes)).slice(0, 12)}.nhsave`;
    } catch (error) {
      hooks.recordDiagnostic({
        level: "warning",
        area: "storage",
        event: listedSave.status === "ready"
          ? "storage.export_failed"
          : "storage.rescue_export_failed",
        moduleId,
        detail: { errorName: hooks.diagnosticErrorName(error) },
      });
      throw error;
    }
    hooks.recordDiagnostic({
      level: "info",
      area: "storage",
      event: listedSave.status === "ready"
        ? "storage.export_completed"
        : "storage.rescue_export_completed",
      moduleId,
    });
    return {
      bytes,
      fileName,
      mimeType: "application/octet-stream",
    };
  }
  
  /** Build one complete backup from a fresh formal-save enumeration. */
  function exportFullBackup(
    moduleId: string,
    profile: BlissHackProfileV1,
  ): Promise<FullBackupExport> {
    return runProtectedHomeOperation("full-backup-export", moduleId, async () => {
      const owner = currentHomeOwner(moduleId, "backup export");
      if (!owner.preparation.storageAvailable) {
        throw new Error("Persistent save storage is unavailable");
      }
      try {
        const text = await createFullBackup(
          owner.storage,
          context.options.loadProfile?.() ?? profile,
          PRODUCT_VERSION,
          BUILD_ID,
        );
        assertCurrentHomeModule(owner);
        hooks.recordDiagnostic({
          level: "info",
          area: "storage",
          event: "backup.export_completed",
          moduleId,
          detail: { saveCount: owner.preparation.saves.length },
        });
        return {
          text,
          fileName: backupDownloadName(new Date()),
          mimeType: "application/json",
        };
      } catch (error) {
        hooks.recordDiagnostic({
          level: "error",
          area: "storage",
          event: "backup.export_failed",
          moduleId,
          detail: { errorName: hooks.diagnosticErrorName(error) },
        });
        throw error;
      }
    }, "Another data operation is already active");
  }
  
  /** Validate and classify one backup without changing local data. */
  function previewFullBackup(
    moduleId: string,
    bytes: Uint8Array,
  ): Promise<BackupImportPreview> {
    return runProtectedHomeOperation("full-backup-preview", moduleId, async () => {
      const owner = currentHomeOwner(moduleId, "backup preview");
      if (!owner.preparation.storageAvailable) {
        throw new Error("Persistent save storage is unavailable");
      }
      try {
        context.options.loadProfile?.();
        return await createBackupPreview(owner.storage, bytes);
      } catch (error) {
        hooks.recordDiagnostic({
          level: "warning",
          area: "storage",
          event: "backup.import_rejected",
          moduleId,
          detail: { errorName: hooks.diagnosticErrorName(error) },
        });
        throw error;
      }
    }, "Another data operation is already active");
  }
  
  /** Apply the selected save portion of a previously validated backup. */
  function importFullBackup(
    moduleId: string,
    preview: BackupImportPreview,
    overwriteFileNames: ReadonlySet<string>,
  ): Promise<FullBackupImportResult> {
    return runProtectedHomeOperation("full-backup-import", moduleId, async () => {
      const owner = currentHomeOwner(moduleId, "backup import");
      let summary: BackupImportSummary;
      try {
        const refreshedPreview = await refreshBackupPreview(
          owner.storage,
          preview,
        );
        if (!backupPreviewMatches(preview, refreshedPreview)) {
          throw new BackupPreviewStaleError(refreshedPreview);
        }
        summary = await importBackupSaves(
          owner.storage,
          preview,
          overwriteFileNames,
        );
      } catch (error) {
        if (error instanceof BackupRollbackError) {
          await hooks.reportFatal(
            "storage",
            "backup.import_rollback_failed",
            error,
          );
        }
        throw error;
      }
      assertCurrentHomeModule(owner);
      let preparation = owner.preparation;
      let refreshFailed = false;
      let refreshedSaves: SaveListEntry[] | null = null;
      try {
        refreshedSaves = await owner.storage.listSaves();
      } catch (error) {
        refreshFailed = true;
        hooks.recordDiagnostic({
          level: "warning",
          area: "storage",
          event: "backup.import_refresh_failed",
          moduleId,
          detail: { errorName: hooks.diagnosticErrorName(error) },
        });
      }
      if (refreshedSaves) {
        assertCurrentHomeModule(owner);
        preparation = { ...owner.preparation, saves: refreshedSaves };
        owner.preparation = preparation;
        context.options.dispatch({
          type: "HOME_SAVES_UPDATED",
          moduleId,
          saves: refreshedSaves,
        });
      }
      hooks.recordDiagnostic({
        level: summary.failed > 0 || refreshFailed ? "warning" : "info",
        area: "storage",
        event: "backup.import_completed",
        moduleId,
        detail: {
          importedCount: summary.imported,
          skippedCount: summary.skipped,
          failedCount: summary.failed,
        },
      });
      return { ...summary, preparation, refreshFailed };
    }, "Another data operation is already active");
  }
  
  /** Clear managed browser data and replace the prepared module generation. */
  function clearLocalData(
    moduleId: string,
    localData: LocalDataStore,
    resetLocalState: () => void,
  ): Promise<HomePreparation> {
    return runProtectedHomeOperation("clear-local-data", moduleId, async () => {
      const owner = currentHomeOwner(moduleId, "clear");
      let localSnapshot: ReturnType<LocalDataStore["snapshot"]>;
      try {
        localSnapshot = localData.snapshot();
      } catch (error) {
        hooks.recordDiagnostic({
          level: "error",
          area: "storage",
          event: "local_data.clear_failed",
          moduleId,
          detail: { errorName: hooks.diagnosticErrorName(error) },
        });
        throw error;
      }
      let saveSnapshot: Awaited<
        ReturnType<StorageService["clearManagedFiles"]>
      > | null = null;
      try {
        saveSnapshot = await owner.storage.clearManagedFiles();
      } catch (error) {
        if (error instanceof AggregateError) {
          await hooks.reportFatal(
            "storage",
            "local_data.clear_rollback_failed",
            error,
          );
        } else {
          hooks.recordDiagnostic({
            level: "error",
            area: "storage",
            event: "local_data.clear_failed",
            moduleId,
            detail: { errorName: hooks.diagnosticErrorName(error) },
          });
        }
        throw error;
      }
  
      try {
        localData.clear();
      } catch (error) {
        const restoreErrors: unknown[] = [];
        try {
          localData.restore(localSnapshot);
        } catch (restoreError) {
          restoreErrors.push(restoreError);
        }
        try {
          await owner.storage.restoreManagedFiles(saveSnapshot);
        } catch (restoreError) {
          restoreErrors.push(restoreError);
        }
        if (restoreErrors.length > 0) {
          const aggregate = new AggregateError(
            [error, ...restoreErrors],
            "Could not clear or restore local data",
          );
          await hooks.reportFatal(
            "storage",
            "local_data.clear_rollback_failed",
            aggregate,
          );
          throw aggregate;
        }
        hooks.recordDiagnostic({
          level: "error",
          area: "storage",
          event: "local_data.clear_failed",
          moduleId,
          detail: { errorName: hooks.diagnosticErrorName(error) },
        });
        throw error;
      }
  
      try {
        resetLocalState();
      } catch (error) {
        await hooks.reportFatal("app", "local_data.memory_reset_failed", error);
        throw error;
      }
  
      hooks.recordDiagnostic({
        level: "info",
        area: "storage",
        event: "local_data.clear_completed",
        moduleId,
        detail: { saveCount: 0 },
      });
      owner.closed = true;
      context.currentModule = null;
      context.initializePromise = null;
      context.startPromise = null;
      const nextModuleId = context.createModuleId();
      context.options.dispatch({
        type: "LOCAL_DATA_CLEARED",
        moduleId,
        nextModuleId,
      });
      return hooks.prepareModule(nextModuleId);
    }, "Another data operation is already active");
  }
  
  /** Serialize one Home file operation against session startup. */
  function runHomeOperation<T>(
    operation: () => Promise<T>,
    _busyMessage: string,
  ): Promise<T> {
    if (context.startPromise) {
      return Promise.reject(
        new Error("Cannot change saves while an active session owns Home"),
      );
    }
    const previous = context.homeOperationPromise;
    const promise = previous
      ? previous.catch(() => undefined).then(operation)
      : Promise.resolve().then(operation);
    context.homeOperationPromise = promise;
    void promise.finally(() => {
      if (context.homeOperationPromise === promise) context.homeOperationPromise = null;
    }).catch(() => undefined);
    return promise;
  }
  
  /** Acquire a short cross-page lock and preserve stable failure categories. */
  async function runWithGameLock<T>(
    operation: GameLockOperation,
    callback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await context.gameLock.runExclusive(operation, callback);
    } catch (error) {
      recordGameLockFailure(operation, error);
      throw error;
    }
  }
  
  /** Serialize, lock, and refresh one operation owned by the prepared Home. */
  function runProtectedHomeOperation<T>(
    operation: GameLockOperation,
    moduleId: string,
    callback: () => Promise<T>,
    busyMessage: string,
  ): Promise<T> {
    return runHomeOperation(
      () => runWithGameLock(operation, async () => {
        const owner = currentHomeOwner(moduleId, operation);
        if (context.gameLock.supported) await refreshHomeStorage(owner);
        return callback();
      }),
      busyMessage,
    );
  }
  
  /** Acquire the long-lived lock which will be transferred to a session. */
  async function acquireSessionLease(
    operation: Extract<GameLockOperation, "new-game" | "continue-game">,
  ): Promise<GameLockLease> {
    try {
      const lease = await context.gameLock.acquireLease(operation);
      hooks.recordDiagnostic({
        level: "info",
        area: "session",
        event: "game_lock.session_acquired",
        moduleId: context.currentModule?.moduleId ?? null,
      });
      return lease;
    } catch (error) {
      recordGameLockFailure(operation, error);
      throw error;
    }
  }
  
  /** Run one profile action under the Home lock or the active session lease. */
  function runProfileOperation<T>(
    operation: Extract<
      GameLockOperation,
      "profile-save" | "profile-import" | "profile-export"
    >,
    callback: () => Promise<T>,
  ): Promise<T> {
    const session = context.currentModule?.session;
    if (session && !session.closed) {
      return Promise.resolve().then(callback);
    }
    return runHomeOperation(
      () => runWithGameLock(operation, callback),
      "Another profile operation is already active",
    );
  }
  
  /** Record lock contention and browser request failures without user data. */
  function recordGameLockFailure(
    _operation: GameLockOperation,
    error: unknown,
  ): void {
    if (error instanceof GameLockConflictError) {
      hooks.recordDiagnostic({
        level: "warning",
        area: "storage",
        event: "game_lock.conflict",
        moduleId: context.currentModule?.moduleId ?? null,
        sessionId: context.currentModule?.session?.sessionId ?? null,
      });
    } else if (error instanceof GameLockRequestError) {
      hooks.recordDiagnostic({
        level: "warning",
        area: "storage",
        event: "game_lock.request_failed",
        moduleId: context.currentModule?.moduleId ?? null,
        sessionId: context.currentModule?.session?.sessionId ?? null,
        detail: { errorName: hooks.diagnosticErrorName(error.cause) },
      });
    }
  }

  return {
    acquireSessionLease,
    clearLocalData,
    currentHomeOwnerForSession,
    deleteSave,
    exportFullBackup,
    exportSave,
    importFullBackup,
    importSave,
    previewFullBackup,
    recordGameLockFailure,
    refreshHome,
    refreshHomeStorage,
    runProfileOperation,
    waitForPendingOperation: () => context.homeOperationPromise?.catch(() => undefined),
  };
}

/** Build a filesystem-safe UTC backup download name. */
function backupDownloadName(date: Date): string {
  return `blisshack-backup-${
    date.toISOString().replaceAll(":", "-").replace(".000", "")
  }.bhbackup`;
}

/** Remove characters which are unsafe in cross-platform download names. */
function safeDownloadName(playerName: string): string {
  const forbidden = `<>:"/\\|?*`;
  const safeName = Array.from(playerName, (character) =>
    character.charCodeAt(0) < 32 || forbidden.includes(character)
      ? "_"
      : character)
    .join("")
    .replace(/[. ]+$/g, "");
  return safeName || "nethack-save";
}

/** Build the metadata revision bound to one destructive save confirmation. */
function saveListRevision(save: SaveListEntry): string {
  const validation = save.status === "ready"
    ? `${save.identity.playerName}:${save.identity.role}:${save.identity.race}:${
      save.identity.gender
    }:${save.identity.alignment}`
    : `${save.status}:${save.reason}`;
  return `${save.path}:${save.modifiedAt ?? "unknown"}:${validation}`;
}

/** Throw when a storage operation no longer belongs to the current Home. */
function assertCurrentHomeModule(record: ModuleRecord): void {
  if (record.closed || record.session) {
    throw new Error(`Module ${record.moduleId} no longer owns Home`);
  }
}
