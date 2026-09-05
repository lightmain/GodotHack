import {
  useEffect,
  useMemo,
  useReducer,
} from "react";
import "./App.css";
import {
  appReducer,
  initialAppState,
} from "./app/app-state";
import { installBrowserErrorListeners } from "./diagnostics/browser-errors";
import {
  getBrowserDiagnosticLog,
  type DiagnosticLog,
} from "./diagnostics/diagnostic-log";
import { downloadDiagnosticLog } from "./diagnostics/download-diagnostics";
import { FatalScreen } from "./screens/FatalScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { GameScreen } from "./screens/GameScreen";
import { createSessionManager } from "./session/session-manager";
import { useProfileSettings } from "./settings/profile-context";
import type {
  RawSaveImportRequest,
  SaveListEntry,
} from "./storage/storage-service";

/**
 * Render the top-level BlissHack state machine and active screen.
 * @returns the current application screen.
 */
function App({
  diagnostics = getBrowserDiagnosticLog(),
}: {
  diagnostics?: DiagnosticLog;
}) {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const { loadStatus, profile } = useProfileSettings();
  const sessionManager = useMemo(
    () => createSessionManager({
      diagnostics,
      dispatch,
    }),
    [diagnostics, dispatch],
  );

  useEffect(() => {
    diagnostics.record({
      level: "info",
      area: "app",
      event: "app.started",
      detail: { buildId: diagnostics.buildId },
    });
    const removeBrowserErrorListeners = installBrowserErrorListeners(
      ({ event, error }) => {
        void sessionManager.reportFatal("browser", event, error);
      },
    );
    void sessionManager.initialize().catch(() => undefined);
    return () => {
      removeBrowserErrorListeners();
      void sessionManager.dispose();
    };
  }, [diagnostics, sessionManager]);

  useEffect(() => {
    diagnostics.record({
      level: loadStatus === "invalid"
          || loadStatus === "unsupported-schema"
          || loadStatus === "unavailable"
        ? "warning"
        : "info",
      area: "app",
      event: `settings.profile_${loadStatus.replace("-", "_")}`,
      detail: { storageAvailable: loadStatus !== "unavailable" },
    });
  }, [diagnostics, loadStatus]);

  /**
   * Start one session and leave startup failures to the reducer event.
   */
  function startNewGame(): void {
    void sessionManager.startSession({ kind: "new" }).catch(() => undefined);
  }

  /** Open the save list owned by the current home module. */
  function openSavePicker(): void {
    if (state.phase !== "home") return;
    dispatch({ type: "SAVE_PICKER_OPENED", moduleId: state.moduleId });
  }

  /** Return from the save list without replacing its prepared module. */
  function closeSavePicker(): void {
    if (state.phase !== "home" || !state.savePickerOpen) return;
    dispatch({ type: "SAVE_PICKER_CLOSED", moduleId: state.moduleId });
  }

  /** Continue one validated save with the module which enumerated it. */
  function continueGame(save: SaveListEntry): void {
    void sessionManager.startSession({
      kind: "continue",
      save,
    }).catch(() => undefined);
  }

  /** Delete one save through the module which supplied the Home list. */
  async function deleteSave(save: SaveListEntry): Promise<void> {
    if (state.phase !== "home") {
      throw new Error("Save deletion is only available from Home");
    }
    await sessionManager.deleteSave(state.moduleId, save.path);
  }

  /** Import one user-selected raw save through the current Home module. */
  async function importSave(request: RawSaveImportRequest) {
    if (state.phase !== "home") {
      throw new Error("Save import is only available from Home");
    }
    return sessionManager.importSave(state.moduleId, request);
  }

  /** Read one raw save and hand it to the browser download mechanism. */
  async function exportSave(save: SaveListEntry): Promise<void> {
    if (state.phase !== "home") {
      throw new Error("Save export is only available from Home");
    }
    const exported = await sessionManager.exportSave(
      state.moduleId,
      save.path,
    );
    downloadRawSave(exported);
  }

  if (state.phase === "booting") {
    return (
      <main className="app-loading" aria-label="BlissHack loading">
        <span className="app-loading-mark" aria-hidden="true">@</span>
        <span>Preparing BlissHack</span>
      </main>
    );
  }

  if (state.phase === "home") {
    const preparation = sessionManager.getHomePreparation();
    const saves = preparation?.moduleId === state.moduleId
      ? preparation.saves
      : [];
    return (
      <HomeScreen
        moduleId={state.moduleId}
        onContinue={openSavePicker}
        onContinueSave={continueGame}
        onDeleteSave={deleteSave}
        onDismissSavePicker={closeSavePicker}
        onExportDiagnostics={() => downloadDiagnosticLog(diagnostics)}
        onExportSave={exportSave}
        onImportSave={importSave}
        onNewGame={startNewGame}
        savePickerOpen={state.savePickerOpen}
        saves={saves}
        storageAvailable={state.storageAvailable}
      />
    );
  }

  if (state.phase === "fatal") {
    return (
      <FatalScreen
        errorId={state.errorId}
        hasFailedSession={state.sessionId !== null}
        onExportDiagnostics={() => downloadDiagnosticLog(diagnostics)}
        onReload={() => globalThis.location.reload()}
        onReturnHome={() => {
          void sessionManager.recoverHome().catch(() => undefined);
        }}
      />
    );
  }

  if (state.status === "starting") {
    return (
      <main className="session-loading" aria-live="polite">
        <div className="session-loading-mark" aria-hidden="true">
          <span>┌──────────┐</span>
          <span>│ @ · · &gt; │</span>
          <span>└──────────┘</span>
        </div>
        <h1>BlissHack</h1>
        <p>Entering the dungeon</p>
      </main>
    );
  }

  return <GameScreen settings={profile.interface} />;
}

/** Trigger one browser download and release its temporary object URL. */
function downloadRawSave(exported: {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}): void {
  const blob = new Blob([Uint8Array.from(exported.bytes).buffer], {
    type: exported.mimeType,
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exported.fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default App;
