import { describe, expect, it } from "vitest";
import {
  appReducer,
  initialAppState,
  type AppAction,
  type AppState,
  type SessionStatus,
} from "./app-state";

/** Reduce an ordered action sequence from a supplied state. */
function reduce(state: AppState, ...actions: AppAction[]): AppState {
  return actions.reduce(appReducer, state);
}

/** Prepare one home module using only legal lifecycle actions. */
function homeState(moduleId = "module-1"): AppState {
  return reduce(
    initialAppState,
    { type: "MODULE_LOADING", moduleId },
    { type: "STORAGE_LOADING", moduleId },
    { type: "HOME_READY", moduleId, storageAvailable: true },
  );
}

/** Create a running session which has claimed a prepared module. */
function runningSession(sessionId = "session-1"): AppState {
  return reduce(
    homeState(),
    { type: "NEW_GAME", moduleId: "module-1", sessionId },
    { type: "SESSION_RUNNING", sessionId },
  );
}

describe("appReducer legal transitions", () => {
  it("prepares a module before entering home", () => {
    const loadingModule = appReducer(initialAppState, {
      type: "MODULE_LOADING",
      moduleId: "module-1",
    });
    expect(loadingModule).toEqual({
      phase: "booting",
      moduleId: "module-1",
      status: "loading-module",
    });

    const loadingStorage = appReducer(loadingModule, {
      type: "STORAGE_LOADING",
      moduleId: "module-1",
    });
    expect(loadingStorage).toMatchObject({
      phase: "booting",
      status: "loading-storage",
    });

    expect(appReducer(loadingStorage, {
      type: "HOME_READY",
      moduleId: "module-1",
      storageAvailable: true,
    })).toEqual({
      phase: "home",
      moduleId: "module-1",
      savePickerOpen: false,
      storageAvailable: true,
    });
  });

  it("opens and closes the save picker without leaving home", () => {
    const home = homeState();
    const opened = appReducer(home, {
      type: "SAVE_PICKER_OPENED",
      moduleId: "module-1",
    });

    expect(opened).toEqual({
      phase: "home",
      moduleId: "module-1",
      savePickerOpen: true,
      storageAvailable: true,
    });
    expect(appReducer(opened, {
      type: "SAVE_PICKER_CLOSED",
      moduleId: "module-1",
    })).toEqual(home);
  });

  it("opens and closes Settings without replacing the prepared module", () => {
    const home = homeState();
    const settings = appReducer(home, {
      type: "SETTINGS_OPENED",
      moduleId: "module-1",
    });

    expect(settings).toEqual({
      phase: "settings",
      moduleId: "module-1",
      storageAvailable: true,
    });
    expect(appReducer(settings, {
      type: "SETTINGS_CLOSED",
      moduleId: "module-1",
    })).toEqual(home);
  });

  it("keeps the save picker open for importing when no ready saves remain", () => {
    const opened = appReducer(homeState(), {
      type: "SAVE_PICKER_OPENED",
      moduleId: "module-1",
    });

    expect(appReducer(opened, {
      type: "HOME_SAVES_UPDATED",
      moduleId: "module-1",
      saves: [{
        path: "/save/0Broken",
        modifiedAt: null,
        status: "invalid",
        error: "Save is incompatible or damaged",
      }],
    })).toEqual({
      phase: "home",
      moduleId: "module-1",
      savePickerOpen: true,
      storageAvailable: true,
    });
  });

  it("claims the prepared module and starts a session", () => {
    const starting = appReducer(homeState(), {
      type: "NEW_GAME",
      moduleId: "module-1",
      sessionId: "session-1",
    });
    expect(starting).toEqual({
      phase: "session",
      moduleId: "module-1",
      sessionId: "session-1",
      status: "starting",
    });

    expect(appReducer(starting, {
      type: "SESSION_RUNNING",
      sessionId: "session-1",
    })).toMatchObject({ phase: "session", status: "running" });
  });

  it("starts a new game while the save picker is open", () => {
    const opened = appReducer(homeState(), {
      type: "SAVE_PICKER_OPENED",
      moduleId: "module-1",
    });

    expect(appReducer(opened, {
      type: "NEW_GAME",
      moduleId: "module-1",
      sessionId: "session-1",
    })).toEqual({
      phase: "session",
      moduleId: "module-1",
      sessionId: "session-1",
      status: "starting",
    });
  });

  it("moves through booting before returning home after cleanup", () => {
    const exiting = appReducer(runningSession(), {
      type: "SESSION_EXITING",
      sessionId: "session-1",
    });

    expect(exiting).toMatchObject({ phase: "session", status: "exiting" });
    expect(appReducer(exiting, {
      type: "SESSION_CLEANUP_COMPLETED",
      sessionId: "session-1",
      nextModuleId: "module-2",
    })).toEqual({
      phase: "booting",
      moduleId: "module-2",
      status: "loading-module",
    });
  });

  it("supports the save-exit path", () => {
    const saving = appReducer(runningSession(), {
      type: "SESSION_SAVING",
      sessionId: "session-1",
    });
    expect(saving).toMatchObject({ phase: "session", status: "saving" });

    expect(appReducer(saving, {
      type: "SESSION_EXITING",
      sessionId: "session-1",
    })).toMatchObject({ phase: "session", status: "exiting" });
  });

  it.each([
    "starting",
    "running",
    "saving",
    "exiting",
  ] satisfies SessionStatus[])(
    "moves session/%s to fatal for the current session",
    (status) => {
      const state: AppState = {
        phase: "session",
        moduleId: "module-1",
        sessionId: "session-1",
        status,
      };

      expect(appReducer(state, {
        type: "SESSION_FATAL_ERROR",
        sessionId: "session-1",
        errorId: "error-1",
      })).toEqual({
        phase: "fatal",
        moduleId: "module-1",
        sessionId: "session-1",
        errorId: "error-1",
      });
    },
  );

  it("moves any non-fatal phase to one application fatal state", () => {
    expect(appReducer(initialAppState, {
      type: "APP_FATAL_ERROR",
      moduleId: null,
      sessionId: null,
      errorId: "BH-APP00001",
    })).toEqual({
      phase: "fatal",
      moduleId: null,
      sessionId: null,
      errorId: "BH-APP00001",
    });
  });
});

describe("appReducer lifecycle guards", () => {
  it("ignores stale module events", () => {
    const state = homeState("module-1");
    expect(appReducer(state, {
      type: "HOME_READY",
      moduleId: "stale-module",
      storageAvailable: false,
    })).toBe(state);
    expect(appReducer(state, {
      type: "SAVE_PICKER_OPENED",
      moduleId: "stale-module",
    })).toBe(state);
    expect(appReducer(state, {
      type: "SETTINGS_OPENED",
      moduleId: "stale-module",
    })).toBe(state);
  });

  it.each([
    { type: "SESSION_RUNNING", sessionId: "stale-session" },
    {
      type: "SESSION_FATAL_ERROR",
      sessionId: "stale-session",
      errorId: "stale-error",
    },
  ] satisfies AppAction[])("ignores stale $type events", (action) => {
    const state = runningSession("current-session");
    expect(appReducer(state, action)).toBe(state);
  });

  it("does not let RETURN_HOME bypass a running core", () => {
    const state = runningSession();
    expect(appReducer(state, {
      type: "RETURN_HOME",
      moduleId: "module-2",
    })).toBe(state);
  });

  it("rejects an unknown runtime action", () => {
    expect(() => appReducer(
      homeState(),
      { type: "UNKNOWN_ACTION" } as never,
    )).toThrow(/unknown|unsupported|unreachable/i);
  });
});
