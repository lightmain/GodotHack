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
import type { NetHackSettingsV1 } from "../settings/profile";
import { installRuntimeNetHackRc } from "../settings/runtime-nethackrc";

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

/** Public controls for the single-module and single-session lifecycle. */
export interface SessionManager {
  initialize: () => Promise<HomePreparation>;
  startSession: (request?: SessionStartRequest) => Promise<SessionHandle>;
  deleteSave: (
    moduleId: string,
    path: string,
  ) => Promise<HomePreparation>;
  importSave: (
    moduleId: string,
    request: RawSaveImportRequest,
  ) => Promise<HomeSaveImportResult>;
  exportSave: (
    moduleId: string,
    path: string,
  ) => Promise<RawSaveExport>;
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
  let currentModule: ModuleRecord | null = null;
  let initializePromise: Promise<HomePreparation> | null = null;
  let startPromise: Promise<SessionHandle> | null = null;
  let homeOperationPromise: Promise<unknown> | null = null;
  let fatalErrorId: string | null = null;
  let disposed = false;

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

    if (request.settings) {
      try {
        const installRuntimeConfig = options.installRuntimeConfig
          ?? installRuntimeNetHackRc;
        installRuntimeConfig(owner.module, request.settings);
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
      mainPromise: Promise.resolve(),
      cleanupPromise: null,
      continuation: null,
      exitFlushed: false,
      closed: false,
    };
    owner.session = session;
    recordDiagnostic({
      level: "info",
      area: "session",
      event: "session.created",
      moduleId: owner.moduleId,
      sessionId,
    });

    if (request.kind === "continue") {
      if (request.save.status !== "ready") {
        throw new Error("Cannot continue an invalid save");
      }
      const listedSave = owner.preparation.saves.find(
        (save) => save.path === request.save.path && save.status === "ready",
      );
      if (!listedSave || listedSave.status !== "ready") {
        throw new Error("Selected save is not part of the current module");
      }
      session.continuation = {
        path: listedSave.path,
        originalBytes: await owner.storage.readSave(listedSave.path),
        restoreFailed: false,
      };
      applyStartupIdentity(owner.module, listedSave.identity);
      applyRestoreRequired(owner.module, true);
    }

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
  ): Promise<HomePreparation> {
    return runHomeOperation(
      () => deletePreparedSave(moduleId, path),
      "Another save operation is already active",
    );
  }

  /** Execute a validated Home deletion against its module-bound storage. */
  async function deletePreparedSave(
    moduleId: string,
    path: string,
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
    if (!owner.preparation.saves.some((save) => save.path === path)) {
      throw new Error("Save path is not listed by the current Home module");
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
    storage: StorageService;
    preparation: HomePreparation;
  } {
    const owner = currentModule;
    if (
      !owner
      || owner.closed
      || owner.moduleId !== moduleId
      || !owner.storage
      || !owner.preparation
      || owner.session
    ) {
      throw new Error(
        `Save ${operation} does not belong to the current Home module`,
      );
    }
    return owner as ModuleRecord & {
      storage: StorageService;
      preparation: HomePreparation;
    };
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
    return runHomeOperation(
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
   * Read one listed ready save for a browser download.
   * @param moduleId - module generation which displayed the save.
   * @param path - exact path selected from that module's list.
   */
  function exportSave(
    moduleId: string,
    path: string,
  ): Promise<RawSaveExport> {
    return runHomeOperation(
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
      (save) => save.path === path && save.status === "ready",
    );
    if (!listedSave || listedSave.status !== "ready") {
      throw new Error("Save is not a listed ready save");
    }
    let bytes: Uint8Array;
    try {
      bytes = await owner.storage.exportSave(path);
      assertCurrentHomeModule(owner);
    } catch (error) {
      recordDiagnostic({
        level: "warning",
        area: "storage",
        event: "storage.export_failed",
        moduleId,
        detail: { errorName: diagnosticErrorName(error) },
      });
      throw error;
    }
    recordDiagnostic({
      level: "info",
      area: "storage",
      event: "storage.export_completed",
      moduleId,
    });
    return {
      bytes,
      fileName: `${safeDownloadName(listedSave.identity.playerName)}.nhsave`,
      mimeType: "application/octet-stream",
    };
  }

  /** Serialize one Home file operation against session startup. */
  function runHomeOperation<T>(
    operation: () => Promise<T>,
    busyMessage: string,
  ): Promise<T> {
    if (startPromise) {
      return Promise.reject(
        new Error("Cannot change saves while an active session owns Home"),
      );
    }
    if (homeOperationPromise) {
      return Promise.reject(new Error(busyMessage));
    }
    const promise = operation();
    homeOperationPromise = promise;
    void promise.finally(() => {
      if (homeOperationPromise === promise) homeOperationPromise = null;
    }).catch(() => undefined);
    return promise;
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
    if (owner.storage) {
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
    deleteSave,
    importSave,
    exportSave,
    cleanupSession,
    reportFatal,
    recoverHome,
    dispose,
    getActiveSession: () => currentModule?.session?.handle ?? null,
    getHomePreparation: () => currentModule?.preparation ?? null,
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
