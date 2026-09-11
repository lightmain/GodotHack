import type {
  DiagnosticArea,
  DiagnosticEventInput,
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
  type SaveListEntry,
  type StorageModule,
  type StorageService,
} from "../storage/storage-service";
import { installRuntimeNetHackRc } from "../settings/runtime-nethackrc";
import {
  createGameLock,
  type GameLockLease,
} from "../concurrency/game-lock";
import type {
  HomePreparation,
  ModuleRecord,
  SessionHandle,
  SessionManager,
  SessionManagerContext,
  SessionManagerOptions,
  SessionRecord,
  SessionStartRequest,
} from "./session-types";
import { createHomeOperations } from "./home-operations";

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
  const context: SessionManagerContext = {
    applyRestoreRequired: options.setRestoreRequired ?? setRestoreRequired,
    applyStartupIdentity: options.setStartupIdentity ?? setStartupIdentity,
    callbackHost: options.callbackHost
      ?? globalThis as unknown as Record<string, unknown>,
    createModuleId: options.createModuleId ?? defaultModuleId,
    createSessionId: options.createSessionId ?? defaultSessionId,
    currentModule: null,
    disposed: false,
    fatalErrorId: null,
    gameLock: options.gameLock ?? createGameLock(),
    homeOperationPromise: null,
    initializePromise: null,
    options,
    startPromise: null,
    unsupportedLockReported: false,
  };
  const homeOperations = createHomeOperations(context, {
    diagnosticErrorName,
    prepareModule,
    recordDiagnostic,
    reportFatal,
  });

  /** Record one optional lifecycle event without coupling manager availability to it. */
  function recordDiagnostic(input: DiagnosticEventInput): void {
    context.options.diagnostics?.record(input);
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
    if (context.fatalErrorId) return context.fatalErrorId;
    context.fatalErrorId = context.options.diagnostics?.recordFatal({
      area,
      event,
      moduleId,
      sessionId,
      detail,
    }, error).errorId
      ?? errorIdentifier(sessionId ?? moduleId ?? "app", error);
    return context.fatalErrorId;
  }

  /** Prepare one module and its storage before Home becomes ready. */
  function initialize(): Promise<HomePreparation> {
    context.disposed = false;
    if (!context.gameLock.supported && !context.unsupportedLockReported) {
      context.unsupportedLockReported = true;
      recordDiagnostic({
        level: "warning",
        area: "storage",
        event: "game_lock.unsupported",
      });
    }
    if (context.currentModule?.preparation) {
      return Promise.resolve(context.currentModule.preparation);
    }
    if (context.initializePromise) return context.initializePromise;
    return prepareModule(context.createModuleId());
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
    context.currentModule = record;
    recordDiagnostic({
      level: "info",
      area: "wasm",
      event: "module.loading",
      moduleId,
    });
    context.options.dispatch({ type: "MODULE_LOADING", moduleId });

    const modulePromise = Promise.resolve().then(() =>
      context.options.moduleFactory
        ? context.options.moduleFactory()
        : createGameModule(undefined, {
          isCurrent: () =>
            context.currentModule === record && !record.closed && !context.disposed,
        }));

    context.initializePromise = modulePromise
      .then(async (module) => {
        assertCurrentModule(record);
        record.module = module;
        recordDiagnostic({
          level: "info",
          area: "wasm",
          event: "module.loaded",
          moduleId,
        });
        const storage = context.options.createStorageService
          ? context.options.createStorageService(module)
          : createStorageService(module as unknown as StorageModule, {
            validateSaveBytes,
            validateSaveMetadata,
          });
        record.storage = storage;
        context.options.dispatch({ type: "STORAGE_LOADING", moduleId });

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
        context.options.dispatch({
          type: "HOME_READY",
          moduleId,
          storageAvailable,
        });
        return preparation;
      })
      .catch((error: unknown) => {
        if (context.currentModule === record && !record.closed && !context.disposed) {
          record.closed = true;
          context.options.dispatch({
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
    return context.initializePromise;
  }

  /**
   * Claim the prepared module, register its callback, and invoke main once.
   * @param request - whether to start fresh or restore a validated save.
   * @returns the active session handle.
   */
  function startSession(
    request: SessionStartRequest = { kind: "new" },
  ): Promise<SessionHandle> {
    if (context.startPromise) return context.startPromise;
    context.startPromise = startPreparedSession(request).catch((error: unknown) => {
      const session = context.currentModule?.session;
      if (session && !session.closed) void failSession(session, error);
      else context.startPromise = null;
      throw error;
    });
    return context.startPromise;
  }

  /** Complete the asynchronous work needed before calling main. */
  async function startPreparedSession(
    request: SessionStartRequest,
  ): Promise<SessionHandle> {
    await initialize();
    await homeOperations.waitForPendingOperation();
    const operation = request.kind === "continue"
      ? "continue-game"
      : "new-game";
    let lease: GameLockLease | null = await homeOperations.acquireSessionLease(operation);
    try {
      const owner = homeOperations.currentHomeOwnerForSession();
      if (context.gameLock.supported) await homeOperations.refreshHomeStorage(owner);

      const settings = context.options.loadProfile?.().nethack ?? request.settings;
      if (settings) {
        try {
          const installRuntimeConfig = context.options.installRuntimeConfig
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
        context.applyStartupIdentity(owner.module, listedSave.identity);
        context.applyRestoreRequired(owner.module, true);
      }

      const sessionId = context.createSessionId();
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
      context.options.dispatch({
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

  /** Register the callback owned by one session and module. */
  function registerCallback(owner: ModuleRecord, session: SessionRecord): void {
    const module = owner.module as EmscriptenModule;
    context.callbackHost[session.callbackName] = async (
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
        context.options.dispatch({ type: "SESSION_RUNNING", sessionId: session.sessionId });
      } else if (name === "shim_exit_nhwindows") {
        recordDiagnostic({
          level: "info",
          area: "session",
          event: "session.exiting",
          moduleId: owner.moduleId,
          sessionId: session.sessionId,
        });
        context.options.dispatch({ type: "SESSION_EXITING", sessionId: session.sessionId });
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
      context.options.dispatch({ type: "SESSION_EXITING", sessionId: session.sessionId });
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
      delete context.callbackHost[session.callbackName];
      resetBridgeState();
      recordDiagnostic({
        level: "info",
        area: "session",
        event: "session.cleaned",
        moduleId: owner.moduleId,
        sessionId: session.sessionId,
      });
      if (context.currentModule === owner) {
        context.currentModule = null;
        context.initializePromise = null;
        context.startPromise = null;
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
        homeOperations.recordGameLockFailure(
          session.continuation ? "continue-game" : "new-game",
          error,
        );
      }
      if (prepareNext && !context.disposed) {
        const nextModuleId = context.createModuleId();
        context.options.dispatch({
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
    const owner = context.currentModule;
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
    const owner = context.currentModule;
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
    context.options.dispatch({
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
    const owner = context.currentModule;
    const session = owner?.session;
    if (owner && session && isCurrentSession(owner, session)) {
      await failSession(session, error, area, event);
      return;
    }
    if (context.fatalErrorId) return;
    if (!owner) {
      const errorId = identifyFatal(area, event, null, null, error);
      context.options.dispatch({
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
    context.options.dispatch({
      type: "MODULE_FATAL_ERROR",
      moduleId: owner.moduleId,
      errorId,
    });
  }

  /** Discard a failed module and prepare a fresh Home module. */
  function recoverHome(): Promise<HomePreparation> {
    const owner = context.currentModule;
    if (owner?.session && !owner.session.closed) {
      return Promise.reject(
        new Error("Cannot return Home while a failed session remains active"),
      );
    }
    if (owner) owner.closed = true;
    context.currentModule = null;
    context.initializePromise = null;
    context.startPromise = null;
    context.homeOperationPromise = null;
    context.fatalErrorId = null;
    context.disposed = false;
    const moduleId = context.createModuleId();
    recordDiagnostic({
      level: "info",
      area: "app",
      event: "app.return_home",
      moduleId,
    });
    context.options.dispatch({ type: "RETURN_HOME", moduleId });
    return prepareModule(moduleId);
  }

  /** Dispose the current manager without creating another module. */
  async function dispose(): Promise<void> {
    context.disposed = true;
    const owner = context.currentModule;
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
      context.currentModule = null;
      context.initializePromise = null;
    }
  }

  /** Run an input operation only while a live session owns the bridge. */
  function withActiveSession(operation: () => void): void {
    const session = context.currentModule?.session;
    if (!session || session.closed) return;
    operation();
  }

  return {
    initialize,
    startSession,
    refreshHome: homeOperations.refreshHome,
    deleteSave: homeOperations.deleteSave,
    importSave: homeOperations.importSave,
    exportSave: homeOperations.exportSave,
    exportFullBackup: homeOperations.exportFullBackup,
    previewFullBackup: homeOperations.previewFullBackup,
    importFullBackup: homeOperations.importFullBackup,
    clearLocalData: homeOperations.clearLocalData,
    runProfileOperation: homeOperations.runProfileOperation,
    cleanupSession,
    reportFatal,
    recoverHome,
    dispose,
    getActiveSession: () => context.currentModule?.session?.handle ?? null,
    getHomePreparation: () => context.currentModule?.preparation ?? null,
    isGameLockSupported: () => context.gameLock.supported,
    isWaitingForInput: () => {
      const session = context.currentModule?.session;
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
