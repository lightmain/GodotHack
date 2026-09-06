import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AppAction,
} from "../app/app-state";
import { createDiagnosticLog } from "../diagnostics/diagnostic-log";
import {
  NHW_MENU,
  getSnapshot,
  resetGameState,
} from "../game-state";
import type { EmscriptenModule } from "../nethack-bridge";
import {
  createSessionManager,
  type SessionHandle,
  type SessionManager,
  type SessionManagerOptions,
} from "./session-manager";
import { createDefaultProfile } from "../settings/profile";

interface ModuleHarness {
  module: EmscriptenModule;
  memory: Uint8Array;
  resolveMain: (value?: unknown) => void;
  rejectMain: (error: unknown) => void;
  writeString: (pointer: number, value: string) => void;
}

type ShimCallback = (name: string, ...args: unknown[]) => Promise<unknown>;

/**
 * Create the smallest Emscripten module needed by session lifecycle tests.
 * @param label - text returned for the shared pointer fixture.
 * @returns module, memory, and a UTF-8 fixture writer.
 */
function createModuleHarness(label: string): ModuleHarness {
  const memory = new Uint8Array(4096);
  const view = new DataView(memory.buffer);
  let resolveMain!: (value?: unknown) => void;
  let rejectMain!: (error: unknown) => void;
  const mainResult = new Promise<unknown>((resolve, reject) => {
    resolveMain = resolve;
    rejectMain = reject;
  });

  /**
   * Write a NUL-terminated string into this module's private memory.
   * @param pointer - destination address.
   * @param value - UTF-8 fixture text.
   */
  function writeString(pointer: number, value: string): void {
    const encoded = new TextEncoder().encode(value);
    memory.set(encoded, pointer);
    memory[pointer + encoded.length] = 0;
  }

  writeString(256, label);
  const module: EmscriptenModule = {
    ccall: vi.fn((name: string) => name === "main" ? mainResult : undefined),
    getValue: vi.fn((pointer: number, type: string) => {
      if (type === "i8") return view.getInt8(pointer);
      if (type === "i16") return view.getInt16(pointer, true);
      return view.getInt32(pointer, true);
    }),
    setValue: vi.fn((pointer: number, value: number, type: string) => {
      if (type === "i8") view.setInt8(pointer, value);
      else if (type === "i16") view.setInt16(pointer, value, true);
      else view.setInt32(pointer, value, true);
    }),
    UTF8ToString: vi.fn((pointer: number) => {
      let end = pointer;
      while (memory[end] !== 0) end += 1;
      return new TextDecoder().decode(memory.subarray(pointer, end));
    }),
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
  };
  return {
    module,
    memory,
    resolveMain,
    rejectMain,
    writeString,
  };
}

/**
 * Read the callback registered by one session from its callback host.
 * @param callbackHost - host supplied to the manager.
 * @param handle - active session handle.
 * @returns the registered shim callback.
 */
function callbackFor(
  callbackHost: Record<string, unknown>,
  handle: SessionHandle,
): ShimCallback {
  const callback = callbackHost[handle.callbackName];
  expect(callback).toBeTypeOf("function");
  return callback as ShimCallback;
}

/**
 * Determine whether a Promise settles during the current microtask turn.
 * @param promise - Promise under observation.
 * @returns true when the Promise has settled.
 */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return settled;
}

/**
 * Create a manager with deterministic IDs and observable dependencies.
 * @param modules - modules returned by consecutive factory calls.
 * @returns manager and its test-visible dependency state.
 */
function createHarness(
  modules: EmscriptenModule[],
  diagnostics = createDiagnosticLog({
    productVersion: "prealpha-test",
    buildId: "test",
    console: { warn: vi.fn(), error: vi.fn() },
    createErrorId: () => "BH-TEST0001",
    storage: null,
  }),
  overrides: Partial<SessionManagerOptions> = {},
): {
  manager: SessionManager;
  callbackHost: Record<string, unknown>;
  dispatch: ReturnType<typeof vi.fn<(action: AppAction) => void>>;
  factory: ReturnType<typeof vi.fn<() => Promise<EmscriptenModule>>>;
} {
  let moduleId = 0;
  let sessionId = 0;
  const callbackHost: Record<string, unknown> = {};
  const dispatch = vi.fn<(action: AppAction) => void>();
  const factory = vi.fn(async () => {
    return modules.shift() ?? createModuleHarness("next-home").module;
  });
  const manager = createSessionManager({
    callbackHost,
    createModuleId: () => `module-${++moduleId}`,
    createSessionId: () => `session-${++sessionId}`,
    createStorageService: () => ({
      initialize: vi.fn(async () => true),
      listSaves: vi.fn(async () => []),
      readSave: vi.fn(async () => new Uint8Array()),
      restoreOriginalSave: vi.fn(async () => undefined),
      deleteSave: vi.fn(async () => undefined),
      exportSave: vi.fn(async () => new Uint8Array()),
      exportAllSaves: vi.fn(async () => []),
      validateSave: vi.fn(async () => ({
        status: "damaged" as const,
        reason: "validation-failed" as const,
      })),
      importSave: vi.fn(async () => ({
        status: "imported" as const,
        path: "/save/0Ada",
      })),
      clearManagedFiles: vi.fn(async () => []),
      restoreManagedFiles: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
    }),
    diagnostics,
    dispatch,
    moduleFactory: factory,
    ...overrides,
  });
  return { manager, callbackHost, dispatch, factory };
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

describe("session creation and startup", () => {
  it("installs the latest NetHack settings before creating a session or calling main", async () => {
    const module = createModuleHarness("module");
    const settings = createDefaultProfile().nethack;
    settings.numberPad = 4;
    const installRuntimeConfig = vi.fn();
    const { manager, dispatch } = createHarness(
      [module.module],
      undefined,
      { installRuntimeConfig },
    );

    await manager.initialize();
    dispatch.mockClear();
    await manager.startSession({ kind: "new", settings });

    expect(installRuntimeConfig).toHaveBeenCalledWith(module.module, settings);
    expect(installRuntimeConfig.mock.invocationCallOrder[0]).toBeLessThan(
      (module.module.ccall as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder[0],
    );
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      "SESSION_CREATED",
    ]);
  });

  it("terminates the prepared module without calling main when rc installation fails", async () => {
    const module = createModuleHarness("module");
    const failure = new Error("rc write failed");
    const installRuntimeConfig = vi.fn(() => {
      throw failure;
    });
    const { manager, dispatch } = createHarness(
      [module.module],
      undefined,
      { installRuntimeConfig },
    );

    await manager.initialize();
    dispatch.mockClear();
    await expect(manager.startSession({
      kind: "new",
      settings: createDefaultProfile().nethack,
    })).rejects.toBe(failure);

    expect(module.module.ccall).not.toHaveBeenCalled();
    expect(manager.getActiveSession()).toBeNull();
    expect(dispatch).toHaveBeenCalledWith({
      type: "MODULE_FATAL_ERROR",
      moduleId: "module-1",
      errorId: "BH-TEST0001",
    });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "SESSION_CREATED",
    }));
  });

  it("discards a failed module factory result before returning Home", async () => {
    const replacement = createModuleHarness("replacement");
    const { manager, dispatch, factory } = createHarness([replacement.module]);
    factory.mockRejectedValueOnce(new TypeError("module loader failed"));

    await expect(manager.initialize()).rejects.toThrow("module loader failed");
    expect(dispatch).toHaveBeenCalledWith({
      type: "MODULE_FATAL_ERROR",
      moduleId: "module-1",
      errorId: "BH-TEST0001",
    });

    await expect(manager.recoverHome()).resolves.toMatchObject({
      moduleId: "module-2",
      storageAvailable: true,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "RETURN_HOME",
      moduleId: "module-2",
    });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent starts and calls one module main exactly once", async () => {
    const firstModule = createModuleHarness("first");
    const { manager, dispatch, factory } = createHarness([firstModule.module]);

    const firstStart = manager.startSession();
    const duplicateStart = manager.startSession();

    expect(duplicateStart).toBe(firstStart);
    const [first, duplicate] = await Promise.all([firstStart, duplicateStart]);
    expect(duplicate).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(firstModule.module.ccall).toHaveBeenCalledWith(
      "main",
      "number",
      [],
      [],
      { async: true },
    );
    expect(firstModule.module.ccall).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      "MODULE_LOADING",
      "STORAGE_LOADING",
      "HOME_READY",
      "SESSION_CREATED",
    ]);
  });

  it("creates a fresh module, ID, and callback for each completed game", async () => {
    const firstModule = createModuleHarness("first");
    const secondModule = createModuleHarness("second");
    const { manager, callbackHost, factory } = createHarness([
      firstModule.module,
      secondModule.module,
    ]);

    const first = await manager.startSession();
    const firstCallback = callbackFor(callbackHost, first);
    await manager.cleanupSession(first.sessionId);
    expect(callbackHost[first.callbackName]).toBeUndefined();

    const second = await manager.startSession();

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.callbackName).not.toBe(first.callbackName);
    expect(callbackFor(callbackHost, second)).not.toBe(firstCallback);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(firstModule.module.ccall).toHaveBeenCalledTimes(2);
    expect(secondModule.module.ccall).toHaveBeenCalledWith(
      "main",
      "number",
      [],
      [],
      { async: true },
    );
  });

  it("registers globally unique callback names and removes each on cleanup", async () => {
    const firstModule = createModuleHarness("first");
    const secondModule = createModuleHarness("second");
    const { manager, callbackHost } = createHarness([
      firstModule.module,
      secondModule.module,
    ]);

    const first = await manager.startSession();
    expect(first.callbackName).not.toBe("blissCallback");
    expect(callbackHost[first.callbackName]).toBeTypeOf("function");
    await manager.cleanupSession(first.sessionId);
    expect(first.callbackName in callbackHost).toBe(false);

    const second = await manager.startSession();
    expect(second.callbackName).not.toBe("blissCallback");
    expect(second.callbackName).not.toBe(first.callbackName);
    await manager.cleanupSession(second.sessionId);
    expect(second.callbackName in callbackHost).toBe(false);
  });
});

describe("session callback isolation", () => {
  it("ignores an old callback after a second session becomes active", async () => {
    const firstModule = createModuleHarness("first");
    const secondModule = createModuleHarness("second");
    const { manager, callbackHost, dispatch } = createHarness([
      firstModule.module,
      secondModule.module,
    ]);
    const first = await manager.startSession();
    const staleCallback = callbackFor(callbackHost, first);
    await manager.cleanupSession(first.sessionId);
    const second = await manager.startSession();
    dispatch.mockClear();

    await staleCallback("shim_init_nhwindows", 0, 0);
    await staleCallback("shim_raw_print", "stale message");

    expect(dispatch).not.toHaveBeenCalled();
    expect(getSnapshot().messages).toEqual([]);
    await callbackFor(callbackHost, second)("shim_init_nhwindows", 0, 0);
    expect(dispatch).toHaveBeenCalledWith({
      type: "SESSION_RUNNING",
      sessionId: second.sessionId,
    });
  });

  it("decodes callback pointers only with the module captured by that session", async () => {
    const firstModule = createModuleHarness("first-module");
    const secondModule = createModuleHarness("second-module");
    const { manager, callbackHost } = createHarness([
      firstModule.module,
      secondModule.module,
    ]);

    const first = await manager.startSession();
    await callbackFor(callbackHost, first)("shim_preference_update", 256);
    expect(firstModule.module.UTF8ToString).toHaveBeenCalledWith(256);
    expect(secondModule.module.UTF8ToString).not.toHaveBeenCalled();
    await manager.cleanupSession(first.sessionId);

    const second = await manager.startSession();
    await callbackFor(callbackHost, second)("shim_preference_update", 256);
    expect(secondModule.module.UTF8ToString).toHaveBeenCalledWith(256);
    expect(getSnapshot().lastPreference).toBe("second-module");
  });
});

describe("session cleanup", () => {
  it("invalidates callback and input ownership after a fatal failure", async () => {
    const module = createModuleHarness("module");
    const { manager, callbackHost, dispatch } = createHarness([module.module]);
    const session = await manager.startSession();
    const staleCallback = callbackFor(callbackHost, session);
    const pendingInput = staleCallback("shim_nhgetch");
    expect(manager.isWaitingForInput()).toBe(true);

    await manager.reportFatal(
      "browser",
      "browser.unhandled_rejection",
      new Error("fatal"),
    );

    expect(callbackHost[session.callbackName]).toBeUndefined();
    expect(manager.getActiveSession()).toBeNull();
    expect(manager.isWaitingForInput()).toBe(false);
    expect(dispatch).toHaveBeenCalledWith({
      type: "SESSION_FATAL_ERROR",
      sessionId: session.sessionId,
      errorId: "BH-TEST0001",
    });

    dispatch.mockClear();
    manager.sendKey("h".charCodeAt(0));
    await staleCallback("shim_init_nhwindows");
    expect(await isSettled(pendingInput)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("treats Emscripten exit status zero as successful termination", async () => {
    const module = createModuleHarness("module");
    const { manager, callbackHost, dispatch } = createHarness([module.module]);
    const session = await manager.startSession();
    dispatch.mockClear();

    module.rejectMain({ name: "ExitStatus", status: 0 });

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
        type: "SESSION_CLEANUP_COMPLETED",
        sessionId: session.sessionId,
        nextModuleId: expect.any(String),
      }));
    });
    expect(callbackHost[session.callbackName]).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "SESSION_FATAL_ERROR",
    }));
  });

  it.each([
    {
      name: "menu",
      begin: async (callback: ShimCallback) => {
        const menu = await callback("shim_create_nhwindow", NHW_MENU) as number;
        await callback("shim_start_menu", menu, 0);
        return { pending: callback("shim_select_menu", menu, 1, 512) };
      },
      send: (manager: SessionManager) => {
        manager.submitMenuSelection([{ itemIndex: 0, count: 1 }]);
      },
    },
    {
      name: "yn",
      begin: (callback: ShimCallback) => Promise.resolve({
        pending: callback("shim_yn_function", "Really?", "yn", 110),
      }),
      send: (manager: SessionManager) => {
        manager.sendKey("y".charCodeAt(0));
      },
    },
    {
      name: "line",
      begin: (callback: ShimCallback) => Promise.resolve({
        pending: callback("shim_getlin", "Name:", 512),
      }),
      send: (manager: SessionManager) => {
        manager.submitLine("late");
      },
    },
    {
      name: "key",
      begin: (callback: ShimCallback) => Promise.resolve({
        pending: callback("shim_nhgetch"),
      }),
      send: (manager: SessionManager) => {
        manager.sendKey("h".charCodeAt(0));
      },
    },
  ])("clears pending $name input and ignores input after exit", async ({
    begin,
    send,
  }) => {
    const module = createModuleHarness("module");
    const { manager, callbackHost } = createHarness([module.module]);
    const session = await manager.startSession();
    const { pending } = await begin(callbackFor(callbackHost, session));
    expect(manager.isWaitingForInput()).toBe(true);

    await manager.cleanupSession(session.sessionId);
    send(manager);

    expect(manager.isWaitingForInput()).toBe(false);
    expect(getSnapshot().inputRequest).toBeNull();
    expect(getSnapshot().modal).toBeNull();
    expect(await isSettled(pending)).toBe(false);
  });

  it("clears queued typeahead before the next game", async () => {
    const firstModule = createModuleHarness("first");
    const secondModule = createModuleHarness("second");
    const { manager, callbackHost } = createHarness([
      firstModule.module,
      secondModule.module,
    ]);
    const first = await manager.startSession();
    const firstCallback = callbackFor(callbackHost, first);
    const accepted = firstCallback("shim_nhgetch");
    manager.sendKey("l".charCodeAt(0));
    await expect(accepted).resolves.toBe("l".charCodeAt(0));
    manager.sendKey("h".charCodeAt(0));
    await manager.cleanupSession(first.sessionId);

    const second = await manager.startSession();
    const nextInput = callbackFor(callbackHost, second)("shim_nhgetch");
    expect(await isSettled(nextInput)).toBe(false);
    manager.sendKey("j".charCodeAt(0));
    await expect(nextInput).resolves.toBe("j".charCodeAt(0));
  });

  it("is idempotent and reports cleanup completion once", async () => {
    const module = createModuleHarness("module");
    const { manager, callbackHost, dispatch } = createHarness([module.module]);
    const session = await manager.startSession();

    await Promise.all([
      manager.cleanupSession(session.sessionId),
      manager.cleanupSession(session.sessionId),
    ]);
    await manager.cleanupSession(session.sessionId);

    expect(callbackHost[session.callbackName]).toBeUndefined();
    expect(dispatch.mock.calls.filter(
      ([action]) => action.type === "SESSION_CLEANUP_COMPLETED",
    )).toHaveLength(1);
  });

});
