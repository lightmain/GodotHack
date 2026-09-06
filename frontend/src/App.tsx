import {
  useCallback,
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
import { SettingsScreen } from "./screens/SettingsScreen";
import { createSessionManager } from "./session/session-manager";
import { useProfileSettings } from "./settings/profile-context";
import type { BackupImportPreview } from "./backup/backup-operations";
import { browserLocalDataStore } from "./storage/local-data";
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
  const {
    loadStatus,
    profile,
    replaceProfile,
    resetProfile,
  } = useProfileSettings();
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
    void sessionManager.startSession({
      kind: "new",
      settings: profile.nethack,
    }).catch(() => undefined);
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

  /** Open Settings without replacing or claiming the prepared module. */
  function openSettings(): void {
    if (state.phase !== "home") return;
    dispatch({ type: "SETTINGS_OPENED", moduleId: state.moduleId });
  }

  /** Return to Home with the same prepared module generation. */
  function closeSettings(): void {
    if (state.phase !== "settings") return;
    dispatch({ type: "SETTINGS_CLOSED", moduleId: state.moduleId });
  }

  /** Continue one validated save with the module which enumerated it. */
  function continueGame(save: SaveListEntry): void {
    void sessionManager.startSession({
      kind: "continue",
      save,
      settings: profile.nethack,
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

  /** Export profile and every formal save through the prepared module. */
  async function exportFullBackup() {
    if (state.phase !== "settings") {
      throw new Error("Full backup export is only available from Settings");
    }
    return sessionManager.exportFullBackup(state.moduleId, profile);
  }

  /** Validate one full backup without changing browser data. */
  async function previewFullBackup(bytes: Uint8Array) {
    if (state.phase !== "settings") {
      throw new Error("Full backup import is only available from Settings");
    }
    return sessionManager.previewFullBackup(state.moduleId, bytes);
  }

  /** Apply the save portion of one retained backup preview. */
  async function importFullBackup(
    preview: BackupImportPreview,
    overwriteFileNames: ReadonlySet<string>,
  ) {
    if (state.phase !== "settings") {
      throw new Error("Full backup import is only available from Settings");
    }
    return sessionManager.importFullBackup(
      state.moduleId,
      preview,
      overwriteFileNames,
    );
  }

  /** Clear only BlissHack-managed browser data and rebuild the Home module. */
  async function clearLocalData(): Promise<void> {
    if (state.phase !== "settings") {
      throw new Error("Local data clearing is only available from Settings");
    }
    await sessionManager.clearLocalData(
      state.moduleId,
      browserLocalDataStore(),
      () => {
        resetProfile();
        diagnostics.reset();
      },
    );
  }

  /** Record one non-sensitive persistence API outcome. */
  const recordPersistenceResult = useCallback((result: string) => {
    diagnostics.record({
      level: result === "granted" ? "info" : "warning",
      area: "storage",
      event: result === "error"
        ? "storage.persistence_failed"
        : `storage.persistence_${result}`,
      moduleId: state.moduleId,
    });
  }, [diagnostics, state.moduleId]);

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
        onSettings={openSettings}
        savePickerOpen={state.savePickerOpen}
        saves={saves}
        storageAvailable={state.storageAvailable}
      />
    );
  }

  if (state.phase === "settings") {
    const preparation = sessionManager.getHomePreparation();
    return (
      <SettingsScreen
        getDiagnosticCount={() => diagnostics.events().length}
        loadStatus={loadStatus}
        moduleId={state.moduleId}
        onApply={replaceProfile}
        onBack={closeSettings}
        onClearLocalData={clearLocalData}
        onExportFullBackup={exportFullBackup}
        onImportFullBackup={importFullBackup}
        onPersistenceResult={recordPersistenceResult}
        onPreviewFullBackup={previewFullBackup}
        profile={profile}
        saveCount={preparation?.saves.length ?? 0}
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

  return (
    <GameScreen
      loadStatus={loadStatus}
      moduleId={state.moduleId}
      onApplyProfile={replaceProfile}
      profile={profile}
    />
  );
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
