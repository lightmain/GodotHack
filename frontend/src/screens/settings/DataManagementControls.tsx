import type { ChangeEvent, RefObject } from "react";
import {
  Database,
  Download,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import type { PersistenceStatus } from "../../storage/persistence";

interface DataManagementControlsProps {
  blocked: boolean;
  clearButtonRef: RefObject<HTMLButtonElement | null>;
  dirty: boolean;
  errorMessage?: string;
  errorSource?: "backup-export" | "backup-import" | "clear";
  exportButtonRef: RefObject<HTMLButtonElement | null>;
  importButtonRef: RefObject<HTMLButtonElement | null>;
  importInputRef: RefObject<HTMLInputElement | null>;
  onClear(): void;
  onExport(): void;
  onImport(event: ChangeEvent<HTMLInputElement>): void;
  onRequestImport(): void;
  onRequestPersistence(): void;
  pending: boolean;
  persistence: PersistenceStatus;
}

/** Render storage status and the top-level data management actions. */
export function DataManagementControls({
  blocked,
  clearButtonRef,
  dirty,
  errorMessage,
  errorSource,
  exportButtonRef,
  importButtonRef,
  importInputRef,
  onClear,
  onExport,
  onImport,
  onRequestImport,
  onRequestPersistence,
  pending,
  persistence,
}: DataManagementControlsProps) {
  return (
    <section className="settings-section" aria-labelledby="data-title">
      <header>
        <h2 id="data-title">Data</h2>
      </header>
      <div className="settings-data-content">
        {dirty && (
          <p className="settings-warning" role="status">
            Apply or cancel unsaved settings before managing local data.
          </p>
        )}
        {errorMessage && (
          <p className="settings-error" id="data-operation-error" role="alert">
            {errorMessage}
          </p>
        )}
        <div className="settings-data-status">
          <Database aria-hidden="true" size={18} />
          <span>{persistenceLabel(persistence)}</span>
          {persistence === "not-persistent" && (
            <button
              disabled={pending}
              onClick={onRequestPersistence}
              type="button"
            >
              <ShieldCheck aria-hidden="true" size={17} />
              Protect Local Data
            </button>
          )}
        </div>
        <p className="settings-data-note">
          Browser protection reduces automatic removal under storage pressure.
          Clearing site data, deleting this browser profile, or changing site
          origin still removes access to local data.
        </p>
        <div className="settings-profile-actions">
          <button
            aria-describedby={
              errorSource === "backup-export"
                ? "data-operation-error"
                : undefined
            }
            disabled={blocked}
            onClick={onExport}
            ref={exportButtonRef}
            type="button"
          >
            <Download aria-hidden="true" size={17} />
            Export Full Backup
          </button>
          <button
            aria-describedby={
              errorSource === "backup-import"
                ? "data-operation-error"
                : undefined
            }
            disabled={blocked}
            onClick={onRequestImport}
            ref={importButtonRef}
            type="button"
          >
            <Upload aria-hidden="true" size={17} />
            Import Full Backup
          </button>
          <input
            accept=".bhbackup,application/json"
            aria-describedby={
              errorSource === "backup-import"
                ? "data-operation-error"
                : undefined
            }
            aria-invalid={errorSource === "backup-import" || undefined}
            aria-label="Import full backup file"
            className="settings-file-input"
            disabled={blocked}
            onChange={onImport}
            ref={importInputRef}
            type="file"
          />
          <button
            aria-describedby={
              errorSource === "clear" ? "data-operation-error" : undefined
            }
            className="settings-danger"
            disabled={blocked}
            onClick={onClear}
            ref={clearButtonRef}
            type="button"
          >
            <Trash2 aria-hidden="true" size={17} />
            Clear Local Data
          </button>
        </div>
      </div>
    </section>
  );
}

function persistenceLabel(status: PersistenceStatus): string {
  switch (status) {
    case "checking":
      return "Checking browser storage protection";
    case "persistent":
      return "Protected by browser";
    case "not-persistent":
      return "Not protected by browser";
    case "unsupported":
      return "Persistent storage is not supported";
    case "error":
      return "Could not check persistent storage";
  }
}
