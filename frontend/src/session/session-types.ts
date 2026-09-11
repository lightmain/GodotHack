import type { AppAction } from "../app/app-state";
import type {
  BackupImportPreview,
  BackupImportSummary,
} from "../backup/backup-operations";
import type {
  DiagnosticArea,
  DiagnosticLog,
} from "../diagnostics/diagnostic-log";
import type { EmscriptenModule } from "../nethack-bridge";
import type {
  BlissHackProfileV1,
  NetHackSettingsV1,
} from "../settings/profile";
import type { LocalDataStore } from "../storage/local-data";
import type {
  RawSaveImportRequest,
  RawSaveImportResult,
  SaveIdentity,
  SaveListEntry,
  StorageService,
} from "../storage/storage-service";
import type {
  GameLock,
  GameLockLease,
  GameLockOperation,
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

export interface ModuleRecord {
  moduleId: string;
  module: EmscriptenModule | null;
  storage: StorageService | null;
  preparation: HomePreparation | null;
  session: SessionRecord | null;
  closed: boolean;
}

export interface SessionRecord {
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

export interface SessionManagerContext {
  applyRestoreRequired(
    module: EmscriptenModule,
    required: boolean,
  ): void;
  applyStartupIdentity(
    module: EmscriptenModule,
    identity: SaveIdentity,
  ): void;
  callbackHost: Record<string, unknown>;
  createModuleId(): string;
  createSessionId(): string;
  currentModule: ModuleRecord | null;
  disposed: boolean;
  fatalErrorId: string | null;
  gameLock: GameLock;
  homeOperationPromise: Promise<unknown> | null;
  initializePromise: Promise<HomePreparation> | null;
  options: SessionManagerOptions;
  startPromise: Promise<SessionHandle> | null;
  unsupportedLockReported: boolean;
}
