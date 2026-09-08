import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppAction } from "../app/app-state";
import { resetGameState } from "../game-state";
import type { EmscriptenModule } from "../nethack-bridge";
import { createDefaultProfile } from "../settings/profile";
import {
  createSessionManager,
  type SessionHandle,
  type SessionManagerOptions,
} from "./session-manager";
import { createIsolatedGameLock } from "./session-manager.test-fixtures";

interface ValidatedSave {
  path: string;
  modifiedAt: number | null;
  status: "ready";
  identity: {
    playerName: string;
    role: string;
    race: string;
    gender: string;
    alignment: string;
  };
}

interface HomePreparation {
  moduleId: string;
  saves: ValidatedSave[];
  storageAvailable: boolean;
}

interface SessionStartRequest {
  kind: "new" | "continue";
  save?: ValidatedSave;
  settings?: ReturnType<typeof createDefaultProfile>["nethack"];
}

interface StageTwoSessionManager {
  initialize(): Promise<HomePreparation>;
  startSession(request: SessionStartRequest): Promise<SessionHandle>;
  deleteSave(moduleId: string, path: string): Promise<HomePreparation>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface StageTwoModuleHarness {
  module: EmscriptenModule;
  main: Deferred<unknown>;
}

interface StorageServiceFake {
  initialize: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  refreshFromPersistent?: ReturnType<
    typeof vi.fn<() => Promise<ValidatedSave[]>>
  >;
  listSaves: ReturnType<typeof vi.fn<() => Promise<ValidatedSave[]>>>;
  readSave: ReturnType<typeof vi.fn<(path: string) => Promise<Uint8Array>>>;
  restoreOriginalSave: ReturnType<
    typeof vi.fn<(path: string, bytes: Uint8Array) => Promise<void>>
  >;
  deleteSave: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
  exportSave: ReturnType<
    typeof vi.fn<(path: string) => Promise<Uint8Array>>
  >;
  importSave: ReturnType<
    typeof vi.fn<
      (request: unknown) => Promise<{ status: "imported"; path: string }>
    >
  >;
  flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

/** Create complete metadata for a ready save fixture. */
function identity(playerName: string): ValidatedSave["identity"] {
  return {
    playerName,
    role: "Wiz",
    race: "Hum",
    gender: "Fem",
    alignment: "Neu",
  };
}

type ShimCallback = (name: string, ...args: unknown[]) => Promise<unknown>;

/**
 * Create a manually controlled promise for lifecycle ordering assertions.
 * @returns promise and its external settlement functions.
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Create the minimum WASM module needed by stage-two ownership tests.
 * @returns module and controllable main result.
 */
function createModuleHarness(): StageTwoModuleHarness {
  const main = deferred<unknown>();
  return {
    main,
    module: {
      ccall: vi.fn((name: string) => name === "main" ? main.promise : undefined),
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
    },
  };
}

/**
 * Return the callback registered for a started session.
 * @param host - callback host passed to the manager.
 * @param handle - active session handle.
 * @returns registered shim callback.
 */
function callbackFor(
  host: Record<string, unknown>,
  handle: SessionHandle,
): ShimCallback {
  const callback = host[handle.callbackName];
  expect(callback).toBeTypeOf("function");
  return callback as ShimCallback;
}

/**
 * Construct the future manager contract through the current exported factory.
 * @param options - stage-two dependencies.
 * @returns manager interpreted through the stage-two public contract.
 */
function createStageTwoManager(
  options: Omit<SessionManagerOptions, "createStorageService">
    & {
      createStorageService?: (module: EmscriptenModule) => StorageServiceFake;
    }
    & Record<string, unknown>,
): StageTwoSessionManager {
  const {
    createStorageService: createStorage,
    ...managerOptions
  } = options;
  return createSessionManager({
    gameLock: createIsolatedGameLock(),
    ...managerOptions,
    ...(createStorage
      ? {
        createStorageService: (module) => ({
          refreshFromPersistent: vi.fn(async () => []),
          exportAllSaves: vi.fn(async () => []),
          validateSave: vi.fn(async () => ({
            status: "damaged" as const,
            reason: "validation-failed" as const,
          })),
          clearManagedFiles: vi.fn(async () => []),
          restoreManagedFiles: vi.fn(async () => undefined),
          ...createStorage(module),
        }),
      }
      : {}),
  }) as unknown as StageTwoSessionManager;
}

beforeEach(() => {
  resetGameState();
  (globalThis as Record<string, unknown>).nethackGlobal = {
    globals: {
      flags: {},
      iflags: { wc2_hitpointbar: false, window_inited: false },
      svp: { plname: "" },
    },
    pointers: {},
  };
});

describe("home module ownership", () => {
  it.each([
    {
      kind: "new" as const,
      settings: createDefaultProfile().nethack,
    },
    {
      kind: "continue" as const,
      settings: createDefaultProfile().nethack,
      save: {
        path: "/save/0Ada",
        modifiedAt: 1_700_000_000_000,
        status: "ready" as const,
        identity: identity("Ada"),
      },
    },
  ])("prepares before home and lets $kind claim that module once", async (request) => {
    const module = createModuleHarness();
    const saves = request.save ? [request.save] : [];
    const order: string[] = [];
    const storage: StorageServiceFake = {
      initialize: vi.fn(async () => {
        order.push("initialize");
        return true;
      }),
      listSaves: vi.fn(async () => {
        order.push("list");
        return saves;
      }),
      readSave: vi.fn(async () => Uint8Array.of(1, 2, 3)),
      restoreOriginalSave: vi.fn(async () => undefined),
      deleteSave: vi.fn(async () => undefined),
      exportSave: vi.fn(async () => new Uint8Array()),
      importSave: vi.fn(async () => ({ status: "imported", path: "/save/0Ada" })),
      flush: vi.fn(async () => undefined),
    };
    const factory = vi.fn(async () => {
      order.push("factory");
      return module.module;
    });
    const setStartupIdentity = vi.fn();
    const setRestoreRequired = vi.fn();
    const installRuntimeConfig = vi.fn(() => {
      order.push("install-rc");
    });
    const manager = createStageTwoManager({
      createModuleId: () => "module-1",
      createSessionId: () => "session-1",
      createStorageService: () => storage,
      dispatch: vi.fn((action: AppAction) => {
        order.push(action.type);
      }),
      moduleFactory: factory,
      installRuntimeConfig,
      setRestoreRequired,
      setStartupIdentity,
    });

    await expect(manager.initialize()).resolves.toEqual({
      moduleId: "module-1",
      saves,
      storageAvailable: true,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(storage.initialize).toHaveBeenCalledOnce();
    expect(storage.listSaves).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "MODULE_LOADING",
      "factory",
      "STORAGE_LOADING",
      "initialize",
      "list",
      "HOME_READY",
    ]);
    expect(module.module.ccall).not.toHaveBeenCalledWith(
      "main",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    const first = manager.startSession(request);
    const duplicate = manager.startSession(request);
    expect(duplicate).toBe(first);
    const handle = await first;

    expect(handle.module).toBe(module.module);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(installRuntimeConfig).toHaveBeenCalledOnce();
    expect(installRuntimeConfig).toHaveBeenCalledWith(
      module.module,
      createDefaultProfile().nethack,
    );
    expect(module.module.ccall).toHaveBeenCalledWith(
      "main",
      "number",
      [],
      [],
      { async: true },
    );
    expect(module.module.ccall).toHaveBeenCalledTimes(2);
    if (request.kind === "continue") {
      expect(installRuntimeConfig.mock.invocationCallOrder[0]).toBeLessThan(
        storage.readSave.mock.invocationCallOrder[0],
      );
      expect(setStartupIdentity).toHaveBeenCalledWith(
        module.module,
        request.save.identity,
      );
      expect(setRestoreRequired).toHaveBeenCalledWith(module.module, true);
    } else {
      expect(setStartupIdentity).not.toHaveBeenCalled();
      expect(setRestoreRequired).not.toHaveBeenCalled();
    }
  });

  it("does not fall back to new game when a validated Continue restore fails", async () => {
    const module = createModuleHarness();
    const save: ValidatedSave = {
      path: "/save/0Ada",
      modifiedAt: 1_700_000_000_000,
      status: "ready",
      identity: identity("Ada"),
    };
    const originalBytes = Uint8Array.of(0x10, 0x20, 0x30);
    const storage: StorageServiceFake = {
      initialize: vi.fn(async () => true),
      listSaves: vi.fn(async () => [save]),
      readSave: vi.fn(async () => originalBytes.slice()),
      restoreOriginalSave: vi.fn(async () => undefined),
      deleteSave: vi.fn(async () => undefined),
      exportSave: vi.fn(async () => new Uint8Array()),
      importSave: vi.fn(async () => ({ status: "imported", path: "/save/0Ada" })),
      flush: vi.fn(async () => undefined),
    };
    const callbackHost: Record<string, unknown> = {};
    const dispatch = vi.fn<(action: AppAction) => void>();
    const factory = vi.fn(async () => module.module);
    const setRestoreRequired = vi.fn();
    const manager = createStageTwoManager({
      callbackHost,
      createModuleId: () => "module-1",
      createSessionId: () => "session-1",
      createStorageService: () => storage,
      dispatch,
      moduleFactory: factory,
      setStartupIdentity: vi.fn(),
      setRestoreRequired,
    });
    await manager.initialize();
    const session = await manager.startSession({ kind: "continue", save });

    expect(storage.readSave).toHaveBeenCalledWith(save.path);
    expect(storage.readSave.mock.invocationCallOrder[0]).toBeLessThan(
      (module.module.ccall as ReturnType<typeof vi.fn>).mock.invocationCallOrder
        .at(-1) ?? Number.POSITIVE_INFINITY,
    );
    expect(setRestoreRequired).toHaveBeenCalledWith(module.module, true);

    await callbackFor(callbackHost, session)("shim_player_selection_or_tty");
    module.main.reject({ name: "ExitStatus", status: 1 });

    await vi.waitFor(() => {
      expect(storage.restoreOriginalSave).toHaveBeenCalledWith(
        save.path,
        originalBytes,
      );
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
        type: "SESSION_FATAL_ERROR",
        sessionId: "session-1",
      }));
    });
    expect(storage.flush).toHaveBeenCalledOnce();
    expect(storage.restoreOriginalSave.mock.invocationCallOrder[0])
      .toBeLessThan(storage.flush.mock.invocationCallOrder[0]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(module.module.ccall).toHaveBeenCalledWith(
      "main",
      "number",
      [],
      [],
      { async: true },
    );
    expect(module.module.ccall).toHaveBeenCalledTimes(2);
  });
});

describe("home save deletion", () => {
  it("deletes a currently listed save, re-enumerates, and notifies the UI", async () => {
    const module = createModuleHarness();
    const save: ValidatedSave = {
      path: "/save/0Ada",
      modifiedAt: 1_700_000_000_000,
      status: "ready",
      identity: identity("Ada"),
    };
    const storage: StorageServiceFake = {
      initialize: vi.fn(async () => true),
      listSaves: vi.fn()
        .mockResolvedValueOnce([save])
        .mockResolvedValueOnce([]),
      readSave: vi.fn(async () => new Uint8Array()),
      restoreOriginalSave: vi.fn(async () => undefined),
      deleteSave: vi.fn(async () => undefined),
      exportSave: vi.fn(async () => new Uint8Array()),
      importSave: vi.fn(async () => ({ status: "imported", path: "/save/0Ada" })),
      flush: vi.fn(async () => undefined),
    };
    const dispatch = vi.fn<(action: AppAction) => void>();
    const manager = createStageTwoManager({
      createModuleId: () => "module-1",
      createSessionId: () => "session-1",
      createStorageService: () => storage,
      dispatch,
      moduleFactory: vi.fn(async () => module.module),
    });
    await manager.initialize();
    dispatch.mockClear();

    await expect(manager.deleteSave("module-1", save.path)).resolves.toEqual({
      moduleId: "module-1",
      saves: [],
      storageAvailable: true,
    });

    expect(storage.deleteSave).toHaveBeenCalledOnce();
    expect(storage.deleteSave).toHaveBeenCalledWith(save.path);
    expect(storage.listSaves).toHaveBeenCalledTimes(2);
    expect(storage.deleteSave.mock.invocationCallOrder[0])
      .toBeLessThan(storage.listSaves.mock.invocationCallOrder[1]);
    expect(dispatch).toHaveBeenCalledWith({
      type: "HOME_SAVES_UPDATED",
      moduleId: "module-1",
      saves: [],
    });
  });

  it("rejects deletion while the current module has an active session", async () => {
    const module = createModuleHarness();
    const save: ValidatedSave = {
      path: "/save/0Ada",
      modifiedAt: 1_700_000_000_000,
      status: "ready",
      identity: identity("Ada"),
    };
    const storage: StorageServiceFake = {
      initialize: vi.fn(async () => true),
      listSaves: vi.fn(async () => [save]),
      readSave: vi.fn(async () => new Uint8Array()),
      restoreOriginalSave: vi.fn(async () => undefined),
      deleteSave: vi.fn(async () => undefined),
      exportSave: vi.fn(async () => new Uint8Array()),
      importSave: vi.fn(async () => ({ status: "imported", path: "/save/0Ada" })),
      flush: vi.fn(async () => undefined),
    };
    const manager = createStageTwoManager({
      createModuleId: () => "module-1",
      createSessionId: () => "session-1",
      createStorageService: () => storage,
      dispatch: vi.fn(),
      moduleFactory: vi.fn(async () => module.module),
    });
    await manager.initialize();
    await manager.startSession({ kind: "new" });

    await expect(manager.deleteSave("module-1", save.path)).rejects.toThrow(
      /home|active session/i,
    );
    expect(storage.deleteSave).not.toHaveBeenCalled();
    expect(storage.listSaves).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "stale module",
      moduleId: "module-stale",
      path: "/save/0Ada",
    },
    {
      name: "unknown path",
      moduleId: "module-1",
      path: "/save/0Unknown",
    },
  ])("rejects a $name without deleting storage", async ({ moduleId, path }) => {
    const module = createModuleHarness();
    const save: ValidatedSave = {
      path: "/save/0Ada",
      modifiedAt: 1_700_000_000_000,
      status: "ready",
      identity: identity("Ada"),
    };
    const storage: StorageServiceFake = {
      initialize: vi.fn(async () => true),
      listSaves: vi.fn(async () => [save]),
      readSave: vi.fn(async () => new Uint8Array()),
      restoreOriginalSave: vi.fn(async () => undefined),
      deleteSave: vi.fn(async () => undefined),
      exportSave: vi.fn(async () => new Uint8Array()),
      importSave: vi.fn(async () => ({ status: "imported", path: "/save/0Ada" })),
      flush: vi.fn(async () => undefined),
    };
    const manager = createStageTwoManager({
      createModuleId: () => "module-1",
      createSessionId: () => "session-1",
      createStorageService: () => storage,
      dispatch: vi.fn(),
      moduleFactory: vi.fn(async () => module.module),
    });
    await manager.initialize();

    await expect(manager.deleteSave(moduleId, path)).rejects.toThrow(
      /current|listed|unknown|stale/i,
    );
    expect(storage.deleteSave).not.toHaveBeenCalled();
    expect(storage.listSaves).toHaveBeenCalledOnce();
  });
});

describe("module retirement ordering", () => {
  it("flushes and retires the first module before creating the next home module", async () => {
    const firstModule = createModuleHarness();
    const secondModule = createModuleHarness();
    const flush = deferred<void>();
    const order: string[] = [];
    const firstStorage: StorageServiceFake = {
      initialize: vi.fn(async () => {
        order.push("initialize:first");
        return true;
      }),
      listSaves: vi.fn(async () => {
        order.push("list:first");
        return [];
      }),
      readSave: vi.fn(async () => new Uint8Array()),
      restoreOriginalSave: vi.fn(async () => undefined),
      deleteSave: vi.fn(async () => undefined),
      exportSave: vi.fn(async () => new Uint8Array()),
      importSave: vi.fn(async () => ({ status: "imported", path: "/save/0Ada" })),
      flush: vi.fn(() => {
        order.push("flush:first");
        return flush.promise;
      }),
    };
    const secondStorage: StorageServiceFake = {
      initialize: vi.fn(async () => {
        order.push("initialize:second");
        return true;
      }),
      listSaves: vi.fn(async () => {
        order.push("list:second");
        return [];
      }),
      readSave: vi.fn(async () => new Uint8Array()),
      restoreOriginalSave: vi.fn(async () => undefined),
      deleteSave: vi.fn(async () => undefined),
      exportSave: vi.fn(async () => new Uint8Array()),
      importSave: vi.fn(async () => ({ status: "imported", path: "/save/0Ada" })),
      flush: vi.fn(async () => undefined),
    };
    const modules = [firstModule.module, secondModule.module];
    const storages = [firstStorage, secondStorage];
    const callbackHost: Record<string, unknown> = {};
    let moduleId = 0;
    const factory = vi.fn(async () => {
      const module = modules.shift();
      if (!module) throw new Error("No module fixture remains");
      order.push(module === firstModule.module ? "factory:first" : "factory:second");
      return module;
    });
    const manager = createStageTwoManager({
      callbackHost,
      createModuleId: () => `module-${++moduleId}`,
      createSessionId: () => "session-1",
      createStorageService: () => {
        const storage = storages.shift();
        if (!storage) throw new Error("No storage fixture remains");
        return storage;
      },
      dispatch: vi.fn<(action: AppAction) => void>(),
      moduleFactory: factory,
      setStartupIdentity: vi.fn(),
    });

    await manager.initialize();
    const session = await manager.startSession({ kind: "new" });
    const exiting = callbackFor(callbackHost, session)(
      "shim_exit_nhwindows",
      "saved",
    );

    await vi.waitFor(() => {
      expect(firstStorage.flush).toHaveBeenCalledOnce();
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(secondStorage.initialize).not.toHaveBeenCalled();

    flush.resolve();
    await exiting;
    expect(factory).toHaveBeenCalledTimes(1);

    firstModule.main.reject({ name: "ExitStatus", status: 0 });
    await vi.waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(2);
      expect(secondStorage.listSaves).toHaveBeenCalledOnce();
    });

    expect(callbackHost[session.callbackName]).toBeUndefined();
    expect(order.indexOf("flush:first")).toBeLessThan(
      order.indexOf("factory:second"),
    );
    expect(order).toEqual([
      "factory:first",
      "initialize:first",
      "list:first",
      "flush:first",
      "factory:second",
      "initialize:second",
      "list:second",
    ]);
  });
});
