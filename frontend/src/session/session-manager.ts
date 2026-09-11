/** Stable public façade for the single-module and single-session lifecycle. */
export { createSessionManager } from "./session-lifecycle";

export type {
  FullBackupExport,
  FullBackupImportResult,
  HomePreparation,
  HomeSaveImportResult,
  RawSaveExport,
  SessionHandle,
  SessionManager,
  SessionManagerOptions,
  SessionStartRequest,
} from "./session-types";
