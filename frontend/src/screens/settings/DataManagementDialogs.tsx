import type { RefObject } from "react";
import { Archive } from "lucide-react";
import type {
  BackupImportPreview,
  BackupImportSummary,
} from "../../backup/backup-operations";
import type { BlissHackProfileV1 } from "../../settings/profile";
import { diffProfiles } from "../../settings/profile-diff";
import type { FullBackupImportResult } from "../../session/session-manager";
import { SettingsModal } from "./SettingsModal";

export const CLEAR_CONFIRMATION = "CLEAR BLISSHACK DATA";

export interface CompletedImport {
  preview: BackupImportPreview;
  summary: FullBackupImportResult;
  profileApplied: boolean | null;
}

interface BackupPreviewDialogProps {
  errorMessage?: string;
  onCancel(): void;
  onImport(): void;
  onOverwriteChange(fileName: string, checked: boolean): void;
  overwrites: ReadonlySet<string>;
  pending: boolean;
  preview: BackupImportPreview;
  profile: BlissHackProfileV1;
  returnFocusRef: RefObject<HTMLElement | null>;
}

/** Render the reviewed save and profile changes for a full backup import. */
export function BackupPreviewDialog({
  errorMessage,
  onCancel,
  onImport,
  onOverwriteChange,
  overwrites,
  pending,
  preview,
  profile,
  returnFocusRef,
}: BackupPreviewDialogProps) {
  const profileDifferences = diffProfiles(profile, preview.source.profile);
  return (
    <SettingsModal
      className="settings-data-modal"
      label="Import full backup"
      onCancel={pending ? undefined : onCancel}
      returnFocusRef={returnFocusRef}
    >
      <h2>Import full backup</h2>
      {errorMessage && (
        <p className="settings-error" id="data-operation-error" role="alert">
          {errorMessage}
        </p>
      )}
      <dl className="settings-import-meta">
        <div><dt>Version</dt><dd>{preview.source.productVersion}</dd></div>
        <div><dt>Build</dt><dd>{preview.source.buildId}</dd></div>
        <div>
          <dt>Exported</dt>
          <dd>{formatTime(preview.source.exportedAt)}</dd>
        </div>
      </dl>
      <p>
        {profileDifferences.length} profile changes, {preview.entries.length} saved
        games
      </p>
      {profileDifferences.length > 0 && (
        <div className="settings-differences backup-profile-differences">
          {profileDifferences.map((difference) => (
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
                    onOverwriteChange(
                      entry.fileName,
                      event.currentTarget.checked,
                    );
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
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          aria-describedby={errorMessage ? "data-operation-error" : undefined}
          className="settings-primary"
          disabled={pending}
          onClick={onImport}
          type="button"
        >
          Import Saves
        </button>
      </div>
    </SettingsModal>
  );
}

interface BackupImportResultsDialogProps {
  completed: CompletedImport;
  onApplyProfile(): void;
  onClose(): void;
  profile: BlissHackProfileV1;
  returnFocusRef: RefObject<HTMLElement | null>;
}

/** Render per-save backup results and the independent profile decision. */
export function BackupImportResultsDialog({
  completed,
  onApplyProfile,
  onClose,
  profile,
  returnFocusRef,
}: BackupImportResultsDialogProps) {
  const hasProfileChanges = diffProfiles(
    profile,
    completed.preview.source.profile,
  ).length > 0;
  return (
    <SettingsModal
      className="settings-data-modal"
      label="Backup import results"
      onCancel={completed.summary.refreshFailed ? undefined : onClose}
      returnFocusRef={returnFocusRef}
    >
      <h2>Backup import results</h2>
      <div className="backup-result-counts" role="status">
        <span><strong>{completed.summary.imported}</strong> imported</span>
        <span><strong>{completed.summary.skipped}</strong> skipped</span>
        <span><strong>{completed.summary.failed}</strong> failed</span>
      </div>
      {completed.summary.refreshFailed && (
        <p className="settings-warning" role="alert">
          Saved games were processed, but the list could not be refreshed. Reload
          BlissHack before starting a game.
        </p>
      )}
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
          onClick={onClose}
          type="button"
        >
          {completed.summary.refreshFailed
            ? "Reload BlissHack"
            : completed.profileApplied === true
            ? "Close"
            : "Keep Current Profile"}
        </button>
        <button
          className="settings-primary"
          disabled={completed.profileApplied === true || !hasProfileChanges}
          onClick={onApplyProfile}
          type="button"
        >
          Apply Profile
        </button>
      </div>
    </SettingsModal>
  );
}

interface ClearLocalDataDialogProps {
  diagnosticCount: number;
  errorMessage?: string;
  errorSource?: "backup-export" | "clear";
  onCancel(): void;
  onClear(): void;
  onExport(): void;
  onTextChange(value: string): void;
  pending: boolean;
  profilePresent: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  saveCount: number;
  text: string;
}

/** Render the exact-text confirmation for destructive local-data clearing. */
export function ClearLocalDataDialog({
  diagnosticCount,
  errorMessage,
  errorSource,
  onCancel,
  onClear,
  onExport,
  onTextChange,
  pending,
  profilePresent,
  returnFocusRef,
  saveCount,
  text,
}: ClearLocalDataDialogProps) {
  return (
    <SettingsModal
      alert
      className="settings-data-modal"
      label="Clear local data"
      onCancel={pending ? undefined : onCancel}
      returnFocusRef={returnFocusRef}
    >
      <h2>Clear local data</h2>
      {errorMessage && (
        <p className="settings-error" id="data-operation-error" role="alert">
          {errorMessage}
        </p>
      )}
      <p>
        This deletes {saveCount} saved games, {profilePresent
          ? "the saved profile"
          : "no saved profile"}, and {diagnosticCount} diagnostic events.
      </p>
      <button
        aria-describedby={
          errorSource === "backup-export" ? "data-operation-error" : undefined
        }
        disabled={pending}
        onClick={onExport}
        type="button"
      >
        <Archive aria-hidden="true" size={17} />
        Export Full Backup
      </button>
      <label className="settings-clear-confirmation">
        <span>Type {CLEAR_CONFIRMATION} to continue</span>
        <input
          aria-describedby={
            errorSource === "clear" ? "data-operation-error" : undefined
          }
          autoFocus
          data-modal-initial-focus
          disabled={pending}
          onChange={(event) => onTextChange(event.currentTarget.value)}
          value={text}
        />
      </label>
      <div className="settings-modal-actions">
        <button disabled={pending} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          aria-describedby={
            errorSource === "clear" ? "data-operation-error" : undefined
          }
          className="settings-danger"
          disabled={pending || text !== CLEAR_CONFIRMATION}
          onClick={onClear}
          type="button"
        >
          Clear
        </button>
      </div>
    </SettingsModal>
  );
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

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

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
