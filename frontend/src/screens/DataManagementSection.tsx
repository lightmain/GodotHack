import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  BACKUP_IMPORT_MAX_BYTES,
} from "../backup/backup-file";
import type {
  BackupImportPreview,
} from "../backup/backup-operations";
import { BackupPreviewStaleError } from "../backup/backup-operations";
import {
  browserPersistenceAdapter,
  type PersistenceAdapter,
  type PersistenceStatus,
} from "../storage/persistence";
import type { BlissHackProfileV1 } from "../settings/profile";
import type {
  FullBackupExport,
  FullBackupImportResult,
} from "../session/session-manager";
import { GameLockCancelledError } from "../concurrency/game-lock";
import { DataManagementControls } from "./settings/DataManagementControls";
import {
  BackupImportResultsDialog,
  BackupPreviewDialog,
  CLEAR_CONFIRMATION,
  ClearLocalDataDialog,
  type CompletedImport,
} from "./settings/DataManagementDialogs";

interface DataManagementSectionProps {
  dirty: boolean;
  getDiagnosticCount(): number;
  onApplyProfile(profile: BlissHackProfileV1): Promise<BlissHackProfileV1>;
  onClearLocalData(): Promise<void>;
  onExportFullBackup(): Promise<FullBackupExport>;
  onImportFullBackup(
    preview: BackupImportPreview,
    overwriteFileNames: ReadonlySet<string>,
  ): Promise<FullBackupImportResult>;
  onPersistenceResult?(result: string): void;
  onPreviewFullBackup(bytes: Uint8Array): Promise<BackupImportPreview>;
  persistenceAdapter?: PersistenceAdapter;
  profile: BlissHackProfileV1;
  profilePresent: boolean;
  saveCount: number;
  storageAvailable: boolean;
}

type DataErrorSource = "backup-export" | "backup-import" | "clear";

interface DataError {
  message: string;
  source: DataErrorSource;
}

const IGNORE_PERSISTENCE_RESULT = () => undefined;

/**
 * Render full-backup, persistence, and destructive local-data controls.
 * @param props - current data counts and application-owned operations.
 */
export function DataManagementSection({
  dirty,
  getDiagnosticCount,
  onApplyProfile,
  onClearLocalData,
  onExportFullBackup,
  onImportFullBackup,
  onPersistenceResult = IGNORE_PERSISTENCE_RESULT,
  onPreviewFullBackup,
  persistenceAdapter,
  profile,
  profilePresent,
  saveCount,
  storageAvailable,
}: DataManagementSectionProps) {
  const [adapter] = useState(
    () => persistenceAdapter ?? browserPersistenceAdapter(),
  );
  const [persistence, setPersistence] =
    useState<PersistenceStatus>("checking");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<DataError | null>(null);
  const [preview, setPreview] = useState<BackupImportPreview | null>(null);
  const [overwrites, setOverwrites] = useState<Set<string>>(new Set());
  const [completed, setCompleted] = useState<CompletedImport | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearDiagnosticCount, setClearDiagnosticCount] = useState(0);
  const [clearText, setClearText] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const clearButtonRef = useRef<HTMLButtonElement>(null);
  const blocked = pending || dirty || !storageAvailable;

  useEffect(() => {
    let active = true;
    void adapter.query().then((status) => {
      if (!active) return;
      setPersistence(status);
      if (status === "unsupported") onPersistenceResult("unsupported");
      if (status === "error") onPersistenceResult("error");
    });
    return () => {
      active = false;
    };
  }, [adapter, onPersistenceResult]);

  /** Ask for persistent storage only after an explicit button activation. */
  async function requestPersistence(): Promise<void> {
    if (pending) return;
    setPending(true);
    const result = await adapter.request();
    onPersistenceResult(result);
    if (result === "granted") {
      setPersistence(await adapter.query());
    } else if (result === "unsupported") {
      setPersistence("unsupported");
    } else if (result === "error") {
      setPersistence("error");
    } else {
      setPersistence("not-persistent");
    }
    setPending(false);
  }

  /** Download a complete application backup after all reads succeed. */
  async function exportBackup(): Promise<void> {
    if (blocked) return;
    setPending(true);
    setError(null);
    try {
      downloadText(await onExportFullBackup());
    } catch (operationError) {
      if (!(operationError instanceof GameLockCancelledError)) {
        setError({
          message: "The full backup could not be created.",
          source: "backup-export",
        });
      }
    } finally {
      setPending(false);
    }
  }

  /** Read and preview one selected .bhbackup without changing local data. */
  async function readBackup(
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file || blocked) return;
    setError(null);
    if (file.size > BACKUP_IMPORT_MAX_BYTES) {
      setError({
        message: "The selected backup exceeds the 96 MiB limit.",
        source: "backup-import",
      });
      restoreFocus(importButtonRef);
      return;
    }
    setPending(true);
    try {
      const nextPreview = await onPreviewFullBackup(
        new Uint8Array(await file.arrayBuffer()),
      );
      setOverwrites(new Set());
      setPreview(nextPreview);
    } catch (operationError) {
      if (!(operationError instanceof GameLockCancelledError)) {
        setError({
          message: "The selected backup is damaged, unsupported, or invalid.",
          source: "backup-import",
        });
        restoreFocus(importButtonRef);
      }
    } finally {
      setPending(false);
    }
  }

  /** Execute the retained preview with only explicitly selected overwrites. */
  async function importBackup(): Promise<void> {
    if (!preview || pending) return;
    setPending(true);
    setError(null);
    try {
      const summary = await onImportFullBackup(preview, overwrites);
      setCompleted({ preview, summary, profileApplied: null });
      setPreview(null);
    } catch (operationError) {
      if (operationError instanceof BackupPreviewStaleError) {
        setPreview(operationError.preview);
        setOverwrites(new Set());
        setError({
          message: "Local saves changed. Review the updated backup preview.",
          source: "backup-import",
        });
      } else if (!(operationError instanceof GameLockCancelledError)) {
        setError({
          message: "Backup import stopped because local save data could not be restored.",
          source: "backup-import",
        });
        setPreview(null);
      }
    } finally {
      setPending(false);
    }
  }

  /** Apply the independently reviewed profile after save processing. */
  async function applyImportedProfile(): Promise<void> {
    if (!completed) return;
    try {
      await onApplyProfile(completed.preview.source.profile);
      setCompleted({ ...completed, profileApplied: true });
    } catch (operationError) {
      if (!(operationError instanceof GameLockCancelledError)) {
        setCompleted({ ...completed, profileApplied: false });
      }
    }
  }

  /** Clear all managed data after exact confirmation text. */
  async function clearLocalData(): Promise<void> {
    if (clearText !== CLEAR_CONFIRMATION || pending) return;
    setPending(true);
    setError(null);
    try {
      await onClearLocalData();
    } catch (operationError) {
      if (!(operationError instanceof GameLockCancelledError)) {
        setError({
          message: "Local data could not be cleared. Existing data was preserved when possible.",
          source: "clear",
        });
        setClearOpen(false);
        setClearText("");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <DataManagementControls
        blocked={blocked}
        clearButtonRef={clearButtonRef}
        dirty={dirty}
        errorMessage={
          error
            && !(preview && error.source === "backup-import")
            && !(clearOpen
              && (error.source === "clear" || error.source === "backup-export"))
            ? error.message
            : undefined
        }
        errorSource={
          error
            && !(preview && error.source === "backup-import")
            && !(clearOpen
              && (error.source === "clear" || error.source === "backup-export"))
            ? error.source
            : undefined
        }
        exportButtonRef={exportRef}
        importButtonRef={importButtonRef}
        importInputRef={importRef}
        onClear={() => {
          setClearText("");
          setClearDiagnosticCount(getDiagnosticCount());
          setClearOpen(true);
        }}
        onExport={() => void exportBackup()}
        onImport={(event) => void readBackup(event)}
        onRequestImport={() => importRef.current?.click()}
        onRequestPersistence={() => void requestPersistence()}
        pending={pending}
        persistence={persistence}
      />

      {preview && (
        <BackupPreviewDialog
          errorMessage={
            error?.source === "backup-import" ? error.message : undefined
          }
          onCancel={() => setPreview(null)}
          onImport={() => void importBackup()}
          onOverwriteChange={(fileName, checked) => {
            setOverwrites((current) => {
              const next = new Set(current);
              if (checked) next.add(fileName);
              else next.delete(fileName);
              return next;
            });
          }}
          overwrites={overwrites}
          pending={pending}
          preview={preview}
          profile={profile}
          returnFocusRef={importButtonRef}
        />
      )}

      {completed && (
        <BackupImportResultsDialog
          completed={completed}
          onApplyProfile={() => void applyImportedProfile()}
          onClose={() => {
            if (completed.summary.refreshFailed) {
              globalThis.location.reload();
              return;
            }
            setCompleted(null);
          }}
          profile={profile}
          returnFocusRef={importButtonRef}
        />
      )}

      {clearOpen && (
        <ClearLocalDataDialog
          diagnosticCount={clearDiagnosticCount}
          errorMessage={
            error?.source === "clear" || error?.source === "backup-export"
              ? error.message
              : undefined
          }
          errorSource={
            error?.source === "clear" || error?.source === "backup-export"
              ? error.source
              : undefined
          }
          onCancel={() => {
            setClearOpen(false);
            setClearText("");
          }}
          onClear={() => void clearLocalData()}
          onExport={() => void exportBackup()}
          onTextChange={setClearText}
          pending={pending}
          profilePresent={profilePresent}
          returnFocusRef={clearButtonRef}
          saveCount={saveCount}
          text={clearText}
        />
      )}
    </>
  );
}

/** Download one fully constructed backup JSON document. */
function downloadText(exported: FullBackupExport): void {
  const blob = new Blob([exported.text], { type: exported.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exported.fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Restore focus after the portal cleanup removes background inertness. */
function restoreFocus(
  ref: { readonly current: HTMLElement | null },
): void {
  globalThis.setTimeout(() => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => ref.current?.focus());
    } else {
      ref.current?.focus();
    }
  }, 0);
}
