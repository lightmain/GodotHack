import type { SaveListEntry } from "../storage/storage-service";

/** Lifecycle statuses for a module before it is claimed by a game session. */
export type BootStatus = "loading-module" | "loading-storage";

/** Lifecycle statuses for the single active NetHack session. */
export type SessionStatus = "starting" | "running" | "saving" | "exiting";

/** Authoritative top-level application state. */
export type AppState =
  | { phase: "booting"; moduleId: string | null; status: BootStatus }
  | {
    phase: "home";
    moduleId: string;
    savePickerOpen: boolean;
    storageAvailable: boolean;
  }
  | {
    phase: "settings";
    moduleId: string;
    storageAvailable: boolean;
  }
  | {
    phase: "session";
    moduleId: string;
    sessionId: string;
    status: SessionStatus;
  }
  | {
    phase: "fatal";
    moduleId: string | null;
    sessionId: string | null;
    errorId: string;
  };

/** Events which can move the application through its lifecycle. */
export type AppAction =
  | { type: "MODULE_LOADING"; moduleId: string }
  | { type: "STORAGE_LOADING"; moduleId: string }
  | {
    type: "HOME_READY";
    moduleId: string;
    storageAvailable: boolean;
  }
  | { type: "SAVE_PICKER_OPENED"; moduleId: string }
  | { type: "SAVE_PICKER_CLOSED"; moduleId: string }
  | { type: "SETTINGS_OPENED"; moduleId: string }
  | { type: "SETTINGS_CLOSED"; moduleId: string }
  | {
    type: "HOME_SAVES_UPDATED";
    moduleId: string;
    saves: SaveListEntry[];
  }
  | { type: "NEW_GAME"; moduleId: string; sessionId: string }
  | { type: "CONTINUE_GAME"; moduleId: string; sessionId: string }
  | { type: "SESSION_CREATED"; moduleId: string; sessionId: string }
  | { type: "SESSION_RUNNING"; sessionId: string }
  | { type: "SESSION_SAVING"; sessionId: string }
  | { type: "SESSION_EXITING"; sessionId: string }
  | {
    type: "SESSION_CLEANUP_COMPLETED";
    sessionId: string;
    nextModuleId: string;
  }
  | { type: "MODULE_FATAL_ERROR"; moduleId: string; errorId: string }
  | { type: "SESSION_FATAL_ERROR"; sessionId: string; errorId: string }
  | {
    type: "APP_FATAL_ERROR";
    moduleId: string | null;
    sessionId: string | null;
    errorId: string;
  }
  | { type: "RETURN_HOME"; moduleId: string };

/** Initial state before the first module has been allocated an identity. */
export const initialAppState: AppState = {
  phase: "booting",
  moduleId: null,
  status: "loading-module",
};

/**
 * Apply one lifecycle event to the authoritative application state.
 * @param state - current application state.
 * @param action - lifecycle event to process.
 * @returns the next application state.
 */
export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "MODULE_LOADING":
      return state.phase === "booting" && state.moduleId === null
        ? {
          phase: "booting",
          moduleId: action.moduleId,
          status: "loading-module",
        }
        : state;
    case "STORAGE_LOADING":
      return isCurrentModule(state, action.moduleId)
        && state.phase === "booting"
        ? { ...state, status: "loading-storage" }
        : state;
    case "HOME_READY":
      return isCurrentModule(state, action.moduleId)
        && state.phase === "booting"
        ? {
          phase: "home",
          moduleId: action.moduleId,
          savePickerOpen: false,
          storageAvailable: action.storageAvailable,
        }
        : state;
    case "SAVE_PICKER_OPENED":
      return isCurrentModule(state, action.moduleId)
        && state.phase === "home"
        && state.storageAvailable
        ? { ...state, savePickerOpen: true }
        : state;
    case "SAVE_PICKER_CLOSED":
      return isCurrentModule(state, action.moduleId)
        && state.phase === "home"
        ? { ...state, savePickerOpen: false }
        : state;
    case "SETTINGS_OPENED":
      return isCurrentModule(state, action.moduleId)
        && state.phase === "home"
        ? {
          phase: "settings",
          moduleId: state.moduleId,
          storageAvailable: state.storageAvailable,
        }
        : state;
    case "SETTINGS_CLOSED":
      return isCurrentModule(state, action.moduleId)
        && state.phase === "settings"
        ? {
          phase: "home",
          moduleId: state.moduleId,
          savePickerOpen: false,
          storageAvailable: state.storageAvailable,
        }
        : state;
    case "HOME_SAVES_UPDATED":
      return isCurrentModule(state, action.moduleId)
        && state.phase === "home"
        ? { ...state }
        : state;
    case "NEW_GAME":
    case "CONTINUE_GAME":
    case "SESSION_CREATED":
      return isCurrentModule(state, action.moduleId)
        && state.phase === "home"
        ? {
          phase: "session",
          moduleId: action.moduleId,
          sessionId: action.sessionId,
          status: "starting",
        }
        : state;
    case "SESSION_RUNNING":
      return updateCurrentSession(state, action.sessionId, "running");
    case "SESSION_SAVING":
      return updateCurrentSession(state, action.sessionId, "saving");
    case "SESSION_EXITING":
      return updateCurrentSession(state, action.sessionId, "exiting");
    case "SESSION_CLEANUP_COMPLETED":
      if (!isCurrentSession(state, action.sessionId)) return state;
      return {
        phase: "booting",
        moduleId: action.nextModuleId,
        status: "loading-module",
      };
    case "MODULE_FATAL_ERROR":
      if (!isCurrentModule(state, action.moduleId)) return state;
      return {
        phase: "fatal",
        moduleId: action.moduleId,
        sessionId: null,
        errorId: action.errorId,
      };
    case "SESSION_FATAL_ERROR":
      if (!isCurrentSession(state, action.sessionId)) return state;
      return {
        phase: "fatal",
        moduleId: state.moduleId,
        sessionId: action.sessionId,
        errorId: action.errorId,
      };
    case "APP_FATAL_ERROR":
      return state.phase === "fatal"
        ? state
        : {
          phase: "fatal",
          moduleId: action.moduleId,
          sessionId: action.sessionId,
          errorId: action.errorId,
        };
    case "RETURN_HOME":
      return state.phase === "fatal" && state.sessionId === null
        ? {
          phase: "booting",
          moduleId: action.moduleId,
          status: "loading-module",
        }
        : state;
    default:
      return assertNever(action);
  }
}

/** Return whether state belongs to one module generation. */
function isCurrentModule(state: AppState, moduleId: string): boolean {
  return state.moduleId === moduleId;
}

/** Return whether an event belongs to the active session. */
function isCurrentSession(
  state: AppState,
  sessionId: string,
): state is Extract<AppState, { phase: "session" }> {
  return state.phase === "session" && state.sessionId === sessionId;
}

/** Replace the status of the current session while rejecting stale events. */
function updateCurrentSession(
  state: AppState,
  sessionId: string,
  status: SessionStatus,
): AppState {
  if (!isCurrentSession(state, sessionId)) return state;
  return { ...state, status };
}

/** Enforce exhaustive action handling at compile time and fail unknown input. */
function assertNever(value: never): never {
  const unknownValue: unknown = value;
  const description = typeof unknownValue === "object"
    && unknownValue !== null
    && "type" in unknownValue
    ? String(unknownValue.type)
    : String(value);
  throw new Error(`Unsupported application action: ${description}`);
}
