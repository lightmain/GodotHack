import type { AppAction } from "../app/app-state";
import type {
  DiagnosticArea,
  DiagnosticEventInput,
  DiagnosticLog,
} from "../diagnostics/diagnostic-log";
import { getSnapshot } from "../game-state";
import {
  createGameModule,
  dismissDisplay,
  isWaitingForInput,
  resetBridgeState,
  sendKey,
  sendPosition,
  setKnownSaveNames,
  setRestoreRequired,
  setStartupIdentity,
  shimCallbackForModule,
  submitExtendedCommand,
  submitLine,
  submitMenuSelection,
  validateSaveBytes,
  validateSaveMetadata,
  type EmscriptenModule,
} from "../nethack-bridge";
import {
  createStorageService,
  type SaveIdentity,
  type SaveListEntry,
  type RawSaveImportRequest,
  type RawSaveImportResult,
  type StorageModule,
  type StorageService,
} from "../storage/storage-service";
import type {
  BlissHackProfileV1,
  NetHackSettingsV1,
} from "../settings/profile";
import { installRuntimeNetHackRc } from "../settings/runtime-nethackrc";
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
import type { LocalDataStore } from "../storage/local-data";
import {
  createGameLock,
  GameLockConflictError,
  GameLockRequestError,
  type GameLock,
  type GameLockLease,
  type GameLockOperation,
} from "../concurrency/game-lock";

/** A started session and the callback registered for its WASM module. */
export interface SessionHandle {
  moduleId: string;
  sessionId: string;
  callbackName: string;
  module: EmscriptenModule;
}

/** Result of preparing the game module displayed by Home. */
export interface HomePreparation {
  moduleId: string;
  saves: SaveListEntry[];
  storageAvailable: boolean;
}

/** Request which claims the prepared home module for one game. */
export type SessionStartRequest =
  | { kind: "new"; settings?: NetHackSettingsV1 }
  | {
    kind: "continue";
    save: SaveListEntry;
    settings?: NetHackSettingsV1;
  };

/** Successful import includes the refreshed Home preparation. */
export type HomeSaveImportResult =
  | Exclude<RawSaveImportResult, { status: "imported" }>
  | { status: "imported"; preparation: HomePreparation };

/** Browser download payload for one raw save. */
export interface RawSaveExport {
  bytes: Uint8Array;
  fileName: string;
  mimeType: "application/octet-stream";
}

/** Browser download payload for one complete BlissHack backup. */
export interface FullBackupExport {
  text: string;
  fileName: string;
  mimeType: "application/json";
}

/** Completed backup save import and refreshed Home data. */
export interface FullBackupImportResult extends BackupImportSummary {
  preparation: HomePreparation;
  refreshFailed: boolean;
}

/** Public controls for the single-module and single-session lifecycle. */
export interface SessionManager {
  initialize: () => Promise<HomePreparation>;
  startSession: (request?: SessionStartRequest) => Promise<SessionHandle>;
  refreshHome: (moduleId: string) => Promise<HomePreparation>;
  deleteSave: (
    moduleId: string,
    path: string,
    expected?: SaveListEntry,
  ) => Promise<HomePreparation>;
  importSave: (
    moduleId: string,
    request: RawSaveImportRequest,
  ) => Promise<HomeSaveImportResult>;
  exportSave: (
    moduleId: string,
    path: string,
  ) => Promise<RawSaveExport>;
  exportFullBackup: (
    moduleId: string,
    profile: BlissHackProfileV1,
  ) => Promise<FullBackupExport>;
  previewFullBackup: (
    moduleId: string,
    bytes: Uint8Array,
  ) => Promise<BackupImportPreview>;
  importFullBackup: (
    moduleId: string,
    preview: BackupImportPreview,
    overwriteFileNames: ReadonlySet<string>,
  ) => Promise<FullBackupImportResult>;
  clearLocalData: (
    moduleId: string,
    localData: LocalDataStore,
    resetLocalState: () => void,
  ) => Promise<HomePreparation>;
  runProfileOperation: <T>(
    operation: Extract<
      GameLockOperation,
      "profile-save" | "profile-import" | "profile-export"
    >,
    callback: () => Promise<T>,
  ) => Promise<T>;
  cleanupSession: (sessionId: string) => Promise<void>;
  reportFatal: (
    area: DiagnosticArea,
    event: string,
    error: unknown,
  ) => Promise<void>;
  recoverHome: () => Promise<HomePreparation>;
  dispose: () => Promise<void>;
  getActiveSession: () => SessionHandle | null;
  getHomePreparation: () => HomePreparation | null;
  isGameLockSupported: () => boolean;
  isWaitingForInput: () => boolean;
  sendKey: (value: number) => void;
  sendPosition: (x: number, y: number, modifier: 1 | 2) => void;
  submitLine: (value: string | null) => void;
  submitMenuSelection: (
    selected: Array<{ itemIndex: number; count: number }> | null,
  ) => void;
  submitExtendedCommand: (sourceIndex: number | null) => void;
  dismissDisplay: () => void;
}

/** Dependencies used to create a session manager. */
export interface SessionManagerOptions {
  callbackHost?: Record<string, unknown>;
  createModuleId?: () => string;
  createSessionId?: () => string;
  createStorageService?: (module: EmscriptenModule) => StorageService;
  diagnostics?: DiagnosticLog;
  dispatch: (action: AppAction) => void;
  moduleFactory?: () => Promise<EmscriptenModule>;
  installRuntimeConfig?: (
    module: EmscriptenModule,
    settings: NetHackSettingsV1,
  ) => void;
  gameLock?: GameLock;
  loadProfile?: () => BlissHackProfileV1;
  setRestoreRequired?: (
    module: EmscriptenModule,
    required: boolean,
  ) => void;
  setStartupIdentity?: (
    module: EmscriptenModule,
    identity: SaveIdentity,
  ) => void;
  /** Retained for stage-one callers; storage availability now comes from initialize. */
  storageAvailable?: () => boolean;
}

interface ModuleRecord {
  moduleId: string;
  module: EmscriptenModule | null;
  storage: StorageService | null;
  preparation: HomePreparation | null;
  session: SessionRecord | null;
  closed: boolean;
}

interface SessionRecord {
  sessionId: string;
  callbackName: string;
  handle: SessionHandle;
  lockLease: GameLockLease;
  mainPromise: Promise<unknown>;
  cleanupPromise: Promise<void> | null;
  continuation: {
    path: string;
    originalBytes: Uint8Array;
    restoreFailed: boolean;
  } | null;
  exitFlushed: boolean;
  closed: boolean;
}

let generatedModuleId = 0;
let generatedSessionId = 0;

/**
 * Create the manager which owns the next game module and sole active session.
 * @param options - lifecycle dependencies and application dispatcher.
 * @returns a manager spanning Home preparation through session retirement.
 */
export function createSessionManager(
  options: SessionManagerOptions,
): SessionManager {
  const callbackHost = options.callbackHost
    ?? globalThis as unknown as Record<string, unknown>;
  const createModuleId = options.createModuleId ?? defaultModuleId;
  const createSessionId = options.createSessionId ?? defaultSessionId;
  const applyStartupIdentity = options.setStartupIdentity ?? setStartupIdentity;
  const applyRestoreRequired = options.setRestoreRequired ?? setRestoreRequired;
  const gameLock = options.gameLock ?? createGameLock();
  let currentModule: ModuleRecord | null = null;
  let initializePromise: Promise<HomePreparation> | null = null;
  let startPromise: Promise<SessionHandle> | null = null;
  let homeOperationPromise: Promise<unknown> | null = null;
  let fatalErrorId: string | null = null;
  let disposed = false;
  let unsupportedLockReported = false;

  /** Record one optional lifecycle event without coupling manager availability to it. */
  function recordDiagnostic(input: DiagnosticEventInput): void {
    options.diagnostics?.record(input);
  }

  /** Record the first fatal failure and return its correlation identifier. */
  function identifyFatal(
    area: DiagnosticArea,
    event: string,
    moduleId: string | null,
    sessionId: string | null,
    error: unknown,
    detail?: DiagnosticEventInput["detail"],
  ): string {
    if (fatalErrorId) return fatalErrorId;
    fatalErrorId = options.diagnostics?.recordFatal({
      area,
      event,
      moduleId,
      sessionId,
      detail,
    }, error).errorId
      ?? errorIdentifier(sessionId ?? moduleId ?? "app", error);
    return fatalErrorId;
  }

  /** Prepare one module and its storage before Home becomes ready. */
  function initialize(): Promise<HomePreparation> {
    disposed = false;
    if (!gameLock.supported && !unsupportedLockReported) {
      unsupportedLockReported = true;
      recordDiagnostic({
        level: "warning",
        area: "storage",
        event: "game_lock.unsupported",
      });
    }
    if (currentModule?.preparation) {
      return Promise.resolve(currentModule.preparation);
    }
    if (initializePromise) return initializePromise;
    return prepareModule(createModuleId());
  }

  /** Create and populate one named module generation. */
  function prepareModule(moduleId: string): Promise<HomePreparation> {
    const record: ModuleRecord = {
      moduleId,
      module: null,
      storage: null,
      preparation: null,
      session: null,
      closed: false,
    };
    currentModule = record;
    recordDiagnostic({
      level: "info",
      area: "wasm",
      event: "module.loading",
      moduleId,
    });
    options.dispatch({ type: "MODULE_LOADING", moduleId });

    const modulePromise = Promise.resolve().then(() =>
      options.moduleFactory
        ? options.moduleFactory()
        : createGameModule(undefined, {
          isCurrent: () =>
            currentModule === record && !record.closed && !disposed,
        }));

    initializePromise = modulePromise
      .then(async (module) => {
        assertCurrentModule(record);
        record.module = module;
        recordDiagnostic({
          level: "info",
          area: "wasm",
          event: "module.loaded",
          moduleId,
        });
        const storage = options.createStorageService
          ? options.createStorageService(module)
          : createStorageService(module as unknown as StorageModule, {
            validateSaveBytes,
            validateSaveMetadata,
          });
        record.storage = storage;
        options.dispatch({ type: "STORAGE_LOADING", moduleId });

        let storageAvailable = false;
        let saves: SaveListEntry[] = [];
        try {
          storageAvailable = await storage.initialize();
          if (storageAvailable) saves = await storage.listSaves();
        } catch (error) {
          storageAvailable = false;
          recordDiagnostic({
            level: "warning",
            area: "storage",
            event: "storage.initialize_failed",
            moduleId,
            detail: { errorName: diagnosticErrorName(error) },
          });
        }
        assertCurrentModule(record);

        const preparation = { moduleId, saves, storageAvailable };
        record.preparation = preparation;
        recordDiagnostic({
          level: storageAvailable ? "info" : "warning",
          area: "storage",
          event: storageAvailable
            ? "storage.ready"
            : "storage.unavailable",
          moduleId,
          detail: {
            saveCount: saves.length,
            storageAvailable,
          },
        });
        options.dispatch({
          type: "HOME_READY",
          moduleId,
          storageAvailable,
        });
        return preparation;
      })
      .catch((error: unknown) => {
        if (currentModule === record && !record.closed && !disposed) {
          record.closed = true;
          options.dispatch({
            type: "MODULE_FATAL_ERROR",
            moduleId,
            errorId: identifyFatal(
              "wasm",
              "module.loading_failed",
              moduleId,
              null,
              error,
            ),
          });
        }
        throw error;
      });
    return initializePromise;
  }

  /**
   * Claim the prepared module, register its callback, and invoke main once.
   * @param request - whether to start fresh or restore a validated save.
   * @returns the active session handle.
   */
  function startSession(
    request: SessionStartRequest = { kind: "new" },
  ): Promise<SessionHandle> {
    if (startPromise) return startPromise;
    startPromise = startPreparedSession(request).catch((error: unknown) => {
      const session = currentModule?.session;
      if (session && !session.closed) void failSession(session, error);
      else startPromise = null;
      throw error;
    });
    return startPromise;
  }

  /** Complete the asynchronous work needed before calling main. */
  async function startPreparedSession(
    request: SessionStartRequest,
  ): Promise<SessionHandle> {
    await initialize();
    await homeOperationPromise?.catch(() => undefined);
    const operation = request.kind === "continue"
      ? "continue-game"
      : "new-game";
    let lease: GameLockLease | null = await acquireSessionLease(operation);
    try {
      const owner = currentHomeOwnerForSession();
      if (gameLock.supported) await refreshHomeStorage(owner);

      const settings = options.loadProfile?.().nethack ?? request.settings;
      if (settings) {
        try {
          const installRuntimeConfig = options.installRuntimeConfig
            ?? installRuntimeNetHackRc;
          installRuntimeConfig(owner.module, settings);
          recordDiagnostic({
            level: "info",
            area: "wasm",
            event: "settings.runtime_config_installed",
            moduleId: owner.moduleId,
          });
        } catch (error) {
          await reportFatal(
            "wasm",
            "settings.runtime_config_install_failed",
            error,
          );
          throw error;
        }
      }

      let continuation: SessionRecord["continuation"] = null;
      if (request.kind === "continue") {
        if (request.save.status !== "ready") {
          throw new Error("Cannot continue an unavailable save");
        }
        const listedSave = owner.preparation.saves.find(
          (save) => save.path === request.save.path && save.status === "ready",
        );
        if (!listedSave || listedSave.status !== "ready") {
          throw new Error("Selected save is no longer available");
        }
        continuation = {
          path: listedSave.path,
          originalBytes: await owner.storage.readSave(listedSave.path),
          restoreFailed: false,
        };
        applyStartupIdentity(owner.module, listedSave.identity);
        applyRestoreRequired(owner.module, true);
      }

      const sessionId = createSessionId();
      const callbackName = callbackNameFor(sessionId);
      const handle: SessionHandle = {
        moduleId: owner.moduleId,
        sessionId,
        callbackName,
        module: owner.module,
      };
      const session: SessionRecord = {
        sessionId,
        callbackName,
        handle,
        lockLease: lease,
        mainPromise: Promise.resolve(),
        cleanupPromise: null,
        continuation,
        exitFlushed: false,
        closed: false,
      };
      lease = null;
      owner.session = session;
      recordDiagnostic({
        level: "info",
        area: "session",
        event: "session.created",
        moduleId: owner.moduleId,
        sessionId,
      });

      const knownSaveNames = request.kind === "new"
        ? owner.preparation.saves.flatMap((save) =>
          save.status === "ready" ? [save.identity.playerName] : [])
        : [];
      resetBridgeState();
      setKnownSaveNames(knownSaveNames);
      options.dispatch({
        type: "SESSION_CREATED",
        moduleId: owner.moduleId,
        sessionId,
      });
      registerCallback(owner, session);
      owner.module.ccall(
        "shim_graphics_set_callback",
        null,
        ["string"],
        [callbackName],
      );

      const mainResult = owner.module.ccall(
        "main",
        "number",
        [],
        [],
        { async: true },
      );
      recordDiagnostic({
        level: "info",
        area: "wasm",
        event: "wasm.main_started",
        moduleId: owner.moduleId,
        sessionId,
      });
      session.mainPromise = Promise.resolve(mainResult);
      void session.mainPromise.then(
        () => finishSession(owner, session),
        (error: unknown) => {
          if (session.continuation) {
            void failRestore(
              owner,
              session,
              error,
              "wasm",
              "wasm.main_failed",
            );
          } else if (isSuccessfulExit(error)) {
            void finishSession(owner, session);
          } else {
            void failSession(session, error, "wasm", "wasm.main_failed");
          }
        },
      );
      return handle;
    } finally {
      if (lease) await lease.release();
    }
  }

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
    const owner = currentModule;
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
      recordDiagnostic({
        level: "error",
        area: "storage",
        event: "storage.delete_failed",
        moduleId,
        detail: { errorName: diagnosticErrorName(error) },
      });
      throw error;
    }

    const preparation = { ...owner.preparation, saves };
    owner.preparation = preparation;
    recordDiagnostic({
      level: "info",
      area: "storage",
      event: "storage.delete_completed",
      moduleId,
      detail: { saveCount: saves.length },
    });
    options.dispatch({
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
    const owner = currentModule;
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
    const owner = currentModule;
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
    options.dispatch({
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
      recordDiagnostic({
        level: "warning",
        area: "storage",
        event: "storage.import_rejected",
        moduleId,
        detail: { errorName: diagnosticErrorName(error) },
      });
      throw error;
    }
    assertCurrentHomeModule(owner);
    if (result.status === "conflict") {
      recordDiagnostic({
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
    recordDiagnostic({
      level: "info",
      area: "storage",
      event: "storage.import_completed",
      moduleId,
      detail: { saveCount: saves.length },
    });
    options.dispatch({
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
      recordDiagnostic({
        level: "warning",
        area: "storage",
        event: listedSave.status === "ready"
          ? "storage.export_failed"
          : "storage.rescue_export_failed",
        moduleId,
        detail: { errorName: diagnosticErrorName(error) },
      });
      throw error;
    }
    recordDiagnostic({
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
          options.loadProfile?.() ?? profile,
          PRODUCT_VERSION,
          BUILD_ID,
        );
        assertCurrentHomeModule(owner);
        recordDiagnostic({
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
        recordDiagnostic({
          level: "error",
          area: "storage",
          event: "backup.export_failed",
          moduleId,
          detail: { errorName: diagnosticErrorName(error) },
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
        options.loadProfile?.();
        return await createBackupPreview(owner.storage, bytes);
      } catch (error) {
        recordDiagnostic({
          level: "warning",
          area: "storage",
          event: "backup.import_rejected",
          moduleId,
          detail: { errorName: diagnosticErrorName(error) },
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
          await reportFatal(
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
        recordDiagnostic({
          level: "warning",
          area: "storage",
          event: "backup.import_refresh_failed",
          moduleId,
          detail: { errorName: diagnosticErrorName(error) },
        });
      }
      if (refreshedSaves) {
        assertCurrentHomeModule(owner);
        preparation = { ...owner.preparation, saves: refreshedSaves };
        owner.preparation = preparation;
        options.dispatch({
          type: "HOME_SAVES_UPDATED",
          moduleId,
          saves: refreshedSaves,
        });
      }
      recordDiagnostic({
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
        recordDiagnostic({
          level: "error",
          area: "storage",
          event: "local_data.clear_failed",
          moduleId,
          detail: { errorName: diagnosticErrorName(error) },
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
          await reportFatal(
            "storage",
            "local_data.clear_rollback_failed",
            error,
          );
        } else {
          recordDiagnostic({
            level: "error",
            area: "storage",
            event: "local_data.clear_failed",
            moduleId,
            detail: { errorName: diagnosticErrorName(error) },
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
          await reportFatal(
            "storage",
            "local_data.clear_rollback_failed",
            aggregate,
          );
          throw aggregate;
        }
        recordDiagnostic({
          level: "error",
          area: "storage",
          event: "local_data.clear_failed",
          moduleId,
          detail: { errorName: diagnosticErrorName(error) },
        });
        throw error;
      }

      try {
        resetLocalState();
      } catch (error) {
        await reportFatal("app", "local_data.memory_reset_failed", error);
        throw error;
      }

      recordDiagnostic({
        level: "info",
        area: "storage",
        event: "local_data.clear_completed",
        moduleId,
        detail: { saveCount: 0 },
      });
      owner.closed = true;
      currentModule = null;
      initializePromise = null;
      startPromise = null;
      const nextModuleId = createModuleId();
      options.dispatch({
        type: "LOCAL_DATA_CLEARED",
        moduleId,
        nextModuleId,
      });
      return prepareModule(nextModuleId);
    }, "Another data operation is already active");
  }

  /** Serialize one Home file operation against session startup. */
  function runHomeOperation<T>(
    operation: () => Promise<T>,
    _busyMessage: string,
  ): Promise<T> {
    if (startPromise) {
      return Promise.reject(
        new Error("Cannot change saves while an active session owns Home"),
      );
    }
    const previous = homeOperationPromise;
    const promise = previous
      ? previous.catch(() => undefined).then(operation)
      : Promise.resolve().then(operation);
    homeOperationPromise = promise;
    void promise.finally(() => {
      if (homeOperationPromise === promise) homeOperationPromise = null;
    }).catch(() => undefined);
    return promise;
  }

  /** Acquire a short cross-page lock and preserve stable failure categories. */
  async function runWithGameLock<T>(
    operation: GameLockOperation,
    callback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await gameLock.runExclusive(operation, callback);
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
        if (gameLock.supported) await refreshHomeStorage(owner);
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
      const lease = await gameLock.acquireLease(operation);
      recordDiagnostic({
        level: "info",
        area: "session",
        event: "game_lock.session_acquired",
        moduleId: currentModule?.moduleId ?? null,
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
    const session = currentModule?.session;
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
      recordDiagnostic({
        level: "warning",
        area: "storage",
        event: "game_lock.conflict",
        moduleId: currentModule?.moduleId ?? null,
        sessionId: currentModule?.session?.sessionId ?? null,
      });
    } else if (error instanceof GameLockRequestError) {
      recordDiagnostic({
        level: "warning",
        area: "storage",
        event: "game_lock.request_failed",
        moduleId: currentModule?.moduleId ?? null,
        sessionId: currentModule?.session?.sessionId ?? null,
        detail: { errorName: diagnosticErrorName(error.cause) },
      });
    }
  }

  /** Register the callback owned by one session and module. */
  function registerCallback(owner: ModuleRecord, session: SessionRecord): void {
    const module = owner.module as EmscriptenModule;
    callbackHost[session.callbackName] = async (
      name: string,
      ...args: unknown[]
    ): Promise<unknown> => {
      if (!isCurrentSession(owner, session)) return undefined;
      if (name === "shim_player_selection_or_tty" && session.continuation) {
        session.continuation.restoreFailed = true;
      }

      const result = await shimCallbackForModule(module, name, ...args);
      if (!isCurrentSession(owner, session)) return result;
      if (getSnapshot().phase === "error") {
        const error = new Error(`Bridge callback failed: ${name}`);
        const detail = {
          callback: name,
          inputKind: getSnapshot().inputRequest?.kind ?? null,
        };
        if (session.continuation) {
          await failRestore(
            owner,
            session,
            error,
            "bridge",
            "bridge.callback_failed",
            detail,
          );
        } else {
          await failSession(
            session,
            error,
            "bridge",
            "bridge.callback_failed",
            detail,
          );
        }
        return result;
      }
      if (name === "shim_init_nhwindows") {
        recordDiagnostic({
          level: "info",
          area: "session",
          event: "session.running",
          moduleId: owner.moduleId,
          sessionId: session.sessionId,
        });
        options.dispatch({ type: "SESSION_RUNNING", sessionId: session.sessionId });
      } else if (name === "shim_exit_nhwindows") {
        recordDiagnostic({
          level: "info",
          area: "session",
          event: "session.exiting",
          moduleId: owner.moduleId,
          sessionId: session.sessionId,
        });
        options.dispatch({ type: "SESSION_EXITING", sessionId: session.sessionId });
        try {
          await (owner.storage as StorageService).flush();
          session.exitFlushed = true;
          recordDiagnostic({
            level: "info",
            area: "storage",
            event: "storage.flush_completed",
            moduleId: owner.moduleId,
            sessionId: session.sessionId,
          });
        } catch (error) {
          await failSession(
            session,
            error,
            "storage",
            "storage.flush_failed",
          );
        }
      } else if (name === "shim_nhgetch" && session.continuation) {
        session.continuation = null;
      }
      return result;
    };
  }

  /** Complete a normal main return, retire its module, and prepare the next. */
  async function finishSession(
    owner: ModuleRecord,
    session: SessionRecord,
  ): Promise<void> {
    if (!isCurrentSession(owner, session)) return;
    if (!session.exitFlushed) {
      recordDiagnostic({
        level: "info",
        area: "session",
        event: "session.exiting",
        moduleId: owner.moduleId,
        sessionId: session.sessionId,
      });
      options.dispatch({ type: "SESSION_EXITING", sessionId: session.sessionId });
      try {
        await (owner.storage as StorageService).flush();
      } catch (error) {
        await failSession(
          session,
          error,
          "storage",
          "storage.flush_failed",
        );
        return;
      }
      session.exitFlushed = true;
      recordDiagnostic({
        level: "info",
        area: "storage",
        event: "storage.flush_completed",
        moduleId: owner.moduleId,
        sessionId: session.sessionId,
      });
    }
    await retireSession(owner, session, true);
  }

  /** Restore preserved bytes after the core rejected a Continue attempt. */
  async function failRestore(
    owner: ModuleRecord,
    session: SessionRecord,
    error: unknown,
    area: DiagnosticArea,
    event: string,
    detail?: DiagnosticEventInput["detail"],
  ): Promise<void> {
    if (!isCurrentSession(owner, session) || !session.continuation) return;
    const backup = session.continuation;
    try {
      await (owner.storage as StorageService).restoreOriginalSave(
        backup.path,
        backup.originalBytes,
      );
      await (owner.storage as StorageService).flush();
    } catch (restoreError) {
      error = restoreError;
      area = "storage";
      event = "storage.restore_failed";
      detail = { errorName: diagnosticErrorName(restoreError) };
    }
    await failSession(session, error, area, event, detail);
  }

  /** Release one session and optionally prepare the next home module. */
  async function retireSession(
    owner: ModuleRecord,
    session: SessionRecord,
    prepareNext: boolean,
  ): Promise<void> {
    if (session.cleanupPromise) return session.cleanupPromise;
    session.cleanupPromise = Promise.resolve().then(async () => {
      if (session.closed) return;
      session.closed = true;
      owner.closed = true;
      delete callbackHost[session.callbackName];
      resetBridgeState();
      recordDiagnostic({
        level: "info",
        area: "session",
        event: "session.cleaned",
        moduleId: owner.moduleId,
        sessionId: session.sessionId,
      });
      if (currentModule === owner) {
        currentModule = null;
        initializePromise = null;
        startPromise = null;
      }
      try {
        await session.lockLease.release();
        recordDiagnostic({
          level: "info",
          area: "session",
          event: "game_lock.session_released",
          moduleId: owner.moduleId,
          sessionId: session.sessionId,
        });
      } catch (error) {
        recordGameLockFailure(
          session.continuation ? "continue-game" : "new-game",
          error,
        );
      }
      if (prepareNext && !disposed) {
        const nextModuleId = createModuleId();
        options.dispatch({
          type: "SESSION_CLEANUP_COMPLETED",
          sessionId: session.sessionId,
          nextModuleId,
        });
        await prepareModule(nextModuleId);
      }
    });
    return session.cleanupPromise;
  }

  /** Release the active session exactly once. */
  function cleanupSession(sessionId: string): Promise<void> {
    const owner = currentModule;
    const session = owner?.session;
    if (!owner || !session || session.sessionId !== sessionId) {
      return Promise.resolve();
    }
    return retireSession(owner, session, true);
  }

  /** Invalidate a failed session without reporting successful cleanup. */
  async function failSession(
    session: SessionRecord,
    error: unknown,
    area: DiagnosticArea = "session",
    event = "session.failed",
    detail?: DiagnosticEventInput["detail"],
  ): Promise<void> {
    const owner = currentModule;
    if (!owner || !isCurrentSession(owner, session)) return;
    const errorId = identifyFatal(
      area,
      event,
      owner.moduleId,
      session.sessionId,
      error,
      detail,
    );
    await retireSession(owner, session, false);
    options.dispatch({
      type: "SESSION_FATAL_ERROR",
      sessionId: session.sessionId,
      errorId,
    });
  }

  /** Convert one uncaught browser or React failure into the current fatal state. */
  async function reportFatal(
    area: DiagnosticArea,
    event: string,
    error: unknown,
  ): Promise<void> {
    const owner = currentModule;
    const session = owner?.session;
    if (owner && session && isCurrentSession(owner, session)) {
      await failSession(session, error, area, event);
      return;
    }
    if (fatalErrorId) return;
    if (!owner) {
      const errorId = identifyFatal(area, event, null, null, error);
      options.dispatch({
        type: "APP_FATAL_ERROR",
        moduleId: null,
        sessionId: null,
        errorId,
      });
      return;
    }
    if (owner.closed) return;
    const errorId = identifyFatal(
      area,
      event,
      owner.moduleId,
      null,
      error,
    );
    owner.closed = true;
    options.dispatch({
      type: "MODULE_FATAL_ERROR",
      moduleId: owner.moduleId,
      errorId,
    });
  }

  /** Discard a failed module and prepare a fresh Home module. */
  function recoverHome(): Promise<HomePreparation> {
    const owner = currentModule;
    if (owner?.session && !owner.session.closed) {
      return Promise.reject(
        new Error("Cannot return Home while a failed session remains active"),
      );
    }
    if (owner) owner.closed = true;
    currentModule = null;
    initializePromise = null;
    startPromise = null;
    homeOperationPromise = null;
    fatalErrorId = null;
    disposed = false;
    const moduleId = createModuleId();
    recordDiagnostic({
      level: "info",
      area: "app",
      event: "app.return_home",
      moduleId,
    });
    options.dispatch({ type: "RETURN_HOME", moduleId });
    return prepareModule(moduleId);
  }

  /** Dispose the current manager without creating another module. */
  async function dispose(): Promise<void> {
    disposed = true;
    const owner = currentModule;
    if (!owner) return;
    if (owner.storage && owner.session) {
      try {
        await owner.storage.flush();
      } catch (error) {
        recordDiagnostic({
          level: "warning",
          area: "storage",
          event: "storage.teardown_flush_failed",
          moduleId: owner.moduleId,
          sessionId: owner.session?.sessionId ?? null,
          detail: { errorName: diagnosticErrorName(error) },
        });
        // Page teardown cannot present a recoverable storage workflow.
      }
    }
    if (owner.session) {
      await retireSession(owner, owner.session, false);
    } else {
      owner.closed = true;
      currentModule = null;
      initializePromise = null;
    }
  }

  /** Run an input operation only while a live session owns the bridge. */
  function withActiveSession(operation: () => void): void {
    const session = currentModule?.session;
    if (!session || session.closed) return;
    operation();
  }

  return {
    initialize,
    startSession,
    refreshHome,
    deleteSave,
    importSave,
    exportSave,
    exportFullBackup,
    previewFullBackup,
    importFullBackup,
    clearLocalData,
    runProfileOperation,
    cleanupSession,
    reportFatal,
    recoverHome,
    dispose,
    getActiveSession: () => currentModule?.session?.handle ?? null,
    getHomePreparation: () => currentModule?.preparation ?? null,
    isGameLockSupported: () => gameLock.supported,
    isWaitingForInput: () => {
      const session = currentModule?.session;
      return session !== null
        && session !== undefined
        && !session.closed
        && isWaitingForInput();
    },
    sendKey: (value) => withActiveSession(() => sendKey(value)),
    sendPosition: (x, y, modifier) =>
      withActiveSession(() => sendPosition(x, y, modifier)),
    submitLine: (value) => withActiveSession(() => submitLine(value)),
    submitMenuSelection: (selected) =>
      withActiveSession(() => submitMenuSelection(selected)),
    submitExtendedCommand: (sourceIndex) =>
      withActiveSession(() => submitExtendedCommand(sourceIndex)),
    dismissDisplay: () => withActiveSession(dismissDisplay),
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
  const forbidden = '<>:"/\\|?*';
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

/** Throw when an asynchronous result belongs to an obsolete module. */
function assertCurrentModule(record: ModuleRecord): void {
  if (record.closed) throw new Error(`Module ${record.moduleId} is obsolete`);
}

/** Return whether a session still owns the current module. */
function isCurrentSession(
  owner: ModuleRecord,
  session: SessionRecord,
): boolean {
  return !owner.closed && !session.closed && owner.session === session;
}

/** Generate a non-sensitive module identity for the current tab. */
function defaultModuleId(): string {
  generatedModuleId += 1;
  return `module-${generatedModuleId}-${randomId()}`;
}

/** Generate a non-sensitive session identity for the current tab. */
function defaultSessionId(): string {
  generatedSessionId += 1;
  return `session-${generatedSessionId}-${randomId()}`;
}

/** Return a random suffix without incorporating player information. */
function randomId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? Math.random().toString(36).slice(2);
}

/** Convert a session ID into a legal, unique JavaScript callback identifier. */
function callbackNameFor(sessionId: string): string {
  const safeId = sessionId.replace(/[^A-Za-z0-9_$]/g, "_");
  return `blissCallback_${safeId}`;
}

/** Create a non-sensitive identifier for one lifecycle failure. */
function errorIdentifier(identity: string, error: unknown): string {
  const category = error instanceof Error && error.name
    ? error.name
    : "SessionError";
  return `${identity}:${category}`;
}

/** Return only the non-sensitive JavaScript error category. */
function diagnosticErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError";
}

/** Detect Emscripten's successful ExitStatus rejection. */
function isSuccessfulExit(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    message?: unknown;
    name?: unknown;
    status?: unknown;
  };
  if (candidate.status === 0) return true;
  return candidate.name === "ExitStatus"
    && typeof candidate.message === "string"
    && /\bexit(?:ed)?\(0\)|status 0\b/i.test(candidate.message);
}
