import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import {
  Archive,
  Database,
  Download,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { createPortal } from "react-dom";
import {
  BACKUP_IMPORT_MAX_BYTES,
} from "../backup/backup-file";
import type {
  BackupImportPreview,
  BackupImportSummary,
} from "../backup/backup-operations";
import {
  browserPersistenceAdapter,
  type PersistenceAdapter,
  type PersistenceStatus,
} from "../storage/persistence";
import { diffProfiles } from "../settings/profile-diff";
import type { BlissHackProfileV1 } from "../settings/profile";
import type { FullBackupExport } from "../session/session-manager";

interface DataManagementSectionProps {
  diagnosticCount: number;
  dirty: boolean;
  onApplyProfile(profile: BlissHackProfileV1): BlissHackProfileV1;
  onClearLocalData(): Promise<void>;
  onExportFullBackup(): Promise<FullBackupExport>;
  onImportFullBackup(
    preview: BackupImportPreview,
    overwriteFileNames: ReadonlySet<string>,
  ): Promise<BackupImportSummary>;
  onPersistenceResult?(result: string): void;
  onPreviewFullBackup(bytes: Uint8Array): Promise<BackupImportPreview>;
  persistenceAdapter?: PersistenceAdapter;
  profile: BlissHackProfileV1;
  profilePresent: boolean;
  saveCount: number;
  storageAvailable: boolean;
}

interface CompletedImport {
  preview: BackupImportPreview;
  summary: BackupImportSummary;
  profileApplied: boolean | null;
}

const CLEAR_CONFIRMATION = "CLEAR BLISSHACK DATA";
const IGNORE_PERSISTENCE_RESULT = () => undefined;

/**
 * Render full-backup, persistence, and destructive local-data controls.
 * @param props - current data counts and application-owned operations.
 */
export function DataManagementSection({
  diagnosticCount,
  dirty,
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
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<BackupImportPreview | null>(null);
  const [overwrites, setOverwrites] = useState<Set<string>>(new Set());
  const [completed, setCompleted] = useState<CompletedImport | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
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
    } catch {
      setError("The full backup could not be created.");
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
      setError("The selected backup exceeds the 96 MiB limit.");
      return;
    }
    setPending(true);
    try {
      const nextPreview = await onPreviewFullBackup(
        new Uint8Array(await file.arrayBuffer()),
      );
      setOverwrites(new Set());
      setPreview(nextPreview);
    } catch {
      setError("The selected backup is damaged, unsupported, or invalid.");
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
    } catch {
      setError("Backup import stopped because local save data could not be restored.");
      setPreview(null);
    } finally {
      setPending(false);
    }
  }

  /** Apply the independently reviewed profile after save processing. */
  function applyImportedProfile(): void {
    if (!completed) return;
    try {
      onApplyProfile(completed.preview.source.profile);
      setCompleted({ ...completed, profileApplied: true });
    } catch {
      setCompleted({ ...completed, profileApplied: false });
    }
  }

  /** Clear all managed data after exact confirmation text. */
  async function clearLocalData(): Promise<void> {
    if (clearText !== CLEAR_CONFIRMATION || pending) return;
    setPending(true);
    setError(null);
    try {
      await onClearLocalData();
    } catch {
      setError("Local data could not be cleared. Existing data was preserved when possible.");
      setClearOpen(false);
      setClearText("");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
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
          {error && <p className="settings-error" role="alert">{error}</p>}
          <div className="settings-data-status">
            <Database aria-hidden="true" size={18} />
            <span>{persistenceLabel(persistence)}</span>
            {persistence === "not-persistent" && (
              <button
                disabled={pending}
                onClick={() => void requestPersistence()}
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
              disabled={blocked}
              onClick={() => void exportBackup()}
              ref={exportRef}
              type="button"
            >
              <Download aria-hidden="true" size={17} />
              Export Full Backup
            </button>
            <button
              disabled={blocked}
              onClick={() => importRef.current?.click()}
              ref={importButtonRef}
              type="button"
            >
              <Upload aria-hidden="true" size={17} />
              Import Full Backup
            </button>
            <input
              accept=".bhbackup,application/json"
              aria-label="Import full backup file"
              className="settings-file-input"
              disabled={blocked}
              onChange={(event) => void readBackup(event)}
              ref={importRef}
              type="file"
            />
            <button
              className="settings-danger"
              disabled={blocked}
              onClick={() => {
                setClearText("");
                setClearOpen(true);
              }}
              ref={clearButtonRef}
              type="button"
            >
              <Trash2 aria-hidden="true" size={17} />
              Clear Local Data
            </button>
          </div>
        </div>
      </section>

      {preview && (
        <Modal
          label="Import full backup"
          onCancel={pending ? undefined : () => {
            setPreview(null);
            restoreFocus(importButtonRef);
          }}
        >
          <h2>Import full backup</h2>
          <dl className="settings-import-meta">
            <div><dt>Version</dt><dd>{preview.source.productVersion}</dd></div>
            <div><dt>Build</dt><dd>{preview.source.buildId}</dd></div>
            <div>
              <dt>Exported</dt>
              <dd>{formatTime(preview.source.exportedAt)}</dd>
            </div>
          </dl>
          <p>
            {profileDifferenceCount(profile, preview.source.profile)} profile
            changes, {preview.entries.length} saved games
          </p>
          {profileDifferenceCount(profile, preview.source.profile) > 0 && (
            <div className="settings-differences backup-profile-differences">
              {diffProfiles(profile, preview.source.profile).map((difference) => (
                <div key={difference.path}>
                  <strong>{difference.label}</strong>
                  <span>{difference.current}</span>
                  <span aria-hidden="true">-&gt;</span>
                  <span>{difference.incoming}</span>
                </div>
              ))}
            </div>
          )}
          <div className="backup-preview-list">
            {preview.entries.map((entry) => (
              <label key={entry.fileName}>
                {entry.classification === "conflict"
                  ? (
                    <input
                      checked={overwrites.has(entry.fileName)}
                      disabled={pending}
                      onChange={(event) => {
                        setOverwrites((current) => {
                          const next = new Set(current);
                          if (event.currentTarget.checked) next.add(entry.fileName);
                          else next.delete(entry.fileName);
                          return next;
                        });
                      }}
                      type="checkbox"
                    />
                  )
                  : <span aria-hidden="true" className="backup-preview-marker" />}
                <span>{entry.identity?.playerName ?? entry.fileName}</span>
                <small>{classificationLabel(entry.classification)}</small>
              </label>
            ))}
          </div>
          <div className="settings-modal-actions">
            <button
              autoFocus
              data-modal-initial-focus
              disabled={pending}
              onClick={() => {
                setPreview(null);
                restoreFocus(importButtonRef);
              }}
              type="button"
            >
              Cancel
            </button>
            <button
              className="settings-primary"
              disabled={pending}
              onClick={() => void importBackup()}
              type="button"
            >
              Import Saves
            </button>
          </div>
        </Modal>
      )}

      {completed && (
        <Modal
          label="Backup import results"
          onCancel={() => {
            setCompleted(null);
            restoreFocus(importButtonRef);
          }}
        >
          <h2>Backup import results</h2>
          <div className="backup-result-counts" role="status">
            <span><strong>{completed.summary.imported}</strong> imported</span>
            <span><strong>{completed.summary.skipped}</strong> skipped</span>
            <span><strong>{completed.summary.failed}</strong> failed</span>
          </div>
          <details className="backup-result-details">
            <summary>Individual save results</summary>
            <ul>
              {completed.summary.results.map((result) => (
                <li key={result.fileName}>
                  <span>{result.fileName}</span>
                  <small>{resultLabel(result.status, result.reason)}</small>
                </li>
              ))}
            </ul>
          </details>
          {completed.profileApplied === false && (
            <p className="settings-error" role="alert">
              Saved games were processed, but the profile could not be applied.
            </p>
          )}
          {completed.profileApplied === true && (
            <p className="settings-success" role="status">Profile applied</p>
          )}
          <div className="settings-modal-actions">
            <button
              autoFocus
              data-modal-initial-focus
              onClick={() => {
                setCompleted(null);
                restoreFocus(importButtonRef);
              }}
              type="button"
            >
              {completed.profileApplied === true ? "Close" : "Keep Current Profile"}
            </button>
            <button
              className="settings-primary"
              disabled={
                completed.profileApplied === true
                || profileDifferenceCount(
                  profile,
                  completed.preview.source.profile,
                ) === 0
              }
              onClick={applyImportedProfile}
              type="button"
            >
              Apply Profile
            </button>
          </div>
        </Modal>
      )}

      {clearOpen && (
        <Modal
          alert
          label="Clear local data"
          onCancel={pending ? undefined : () => {
            setClearOpen(false);
            setClearText("");
            restoreFocus(clearButtonRef);
          }}
        >
          <h2>Clear local data</h2>
          <p>
            This deletes {saveCount} saved games, {profilePresent
              ? "the saved profile"
              : "no saved profile"}, and {diagnosticCount} diagnostic events.
          </p>
          <button
            disabled={pending}
            onClick={() => void exportBackup()}
            type="button"
          >
            <Archive aria-hidden="true" size={17} />
            Export Full Backup
          </button>
          <label className="settings-clear-confirmation">
            <span>Type {CLEAR_CONFIRMATION} to continue</span>
            <input
              autoFocus
              data-modal-initial-focus
              disabled={pending}
              onChange={(event) => setClearText(event.currentTarget.value)}
              value={clearText}
            />
          </label>
          <div className="settings-modal-actions">
            <button
              disabled={pending}
              onClick={() => {
                setClearOpen(false);
                setClearText("");
                restoreFocus(clearButtonRef);
              }}
              type="button"
            >
              Cancel
            </button>
            <button
              className="settings-danger"
              disabled={pending || clearText !== CLEAR_CONFIRMATION}
              onClick={() => void clearLocalData()}
              type="button"
            >
              Clear
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Render a portal-backed modal with initial focus and a keyboard focus loop. */
function Modal({
  alert = false,
  children,
  label,
  onCancel,
}: {
  alert?: boolean;
  children: ReactNode;
  label: string;
  onCancel?: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);
  useEffect(() => {
    const modal = ref.current;
    if (!modal) return undefined;
    const settingsScreen = document.querySelector<HTMLElement>(
      ".settings-screen",
    );
    if (settingsScreen) settingsScreen.inert = true;
    const initial = modal.querySelector<HTMLElement>("[data-modal-initial-focus]")
      ?? modal.querySelector<HTMLElement>("button, input, select, textarea");
    initial?.focus();

    function containFocus(event: KeyboardEvent): void {
      if (event.key === "Escape" && onCancelRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = modal
        ? Array.from(modal.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), "
            + "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ))
        : [];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1) as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    modal.addEventListener("keydown", containFocus);
    return () => {
      modal.removeEventListener("keydown", containFocus);
      if (settingsScreen) settingsScreen.inert = false;
    };
  }, []);

  const modal = (
    <div className="settings-modal-backdrop">
      <section
        aria-label={label}
        aria-modal="true"
        className="settings-modal settings-data-modal"
        ref={ref}
        role={alert ? "alertdialog" : "dialog"}
      >
        {children}
      </section>
    </div>
  );
  return typeof document === "undefined"
    ? modal
    : createPortal(modal, document.body);
}

/** Convert the persistence adapter state into concise player-facing text. */
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

/** Explain how one backup save will be handled by the current build. */
function classificationLabel(
  classification: BackupImportPreview["entries"][number]["classification"],
): string {
  switch (classification) {
    case "importable":
      return "Ready to import";
    case "conflict":
      return "Existing save; select to overwrite";
    case "incompatible":
      return "Incompatible; will be skipped";
    case "damaged":
      return "Damaged or unrecognized; will fail";
  }
}

/** Count normalized profile fields which would change on import. */
function profileDifferenceCount(
  current: BlissHackProfileV1,
  incoming: BlissHackProfileV1,
): number {
  return diffProfiles(current, incoming).length;
}

/** Format a validated UTC timestamp in the player's current locale. */
function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Format one per-save import result without exposing raw data. */
function resultLabel(
  status: BackupImportSummary["results"][number]["status"],
  reason: BackupImportSummary["results"][number]["reason"],
): string {
  const reasonText: Record<typeof reason, string> = {
    created: "created",
    overwritten: "overwritten",
    incompatible: "incompatible with this build",
    "conflict-not-overwritten": "existing save kept",
    damaged: "damaged or unrecognized",
    "write-failed": "write failed",
  };
  return `${status}: ${reasonText[reason]}`;
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
  globalThis.setTimeout(() => ref.current?.focus(), 0);
}
