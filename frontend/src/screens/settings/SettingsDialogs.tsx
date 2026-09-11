import type { RefObject } from "react";
import type {
  BlissHackProfileExportV1,
  BlissHackProfileV1,
} from "../../settings/profile";
import type { ProfileDifference } from "../../settings/profile-diff";
import { SettingsModal } from "./SettingsModal";

export interface ImportPreview {
  differences: ProfileDifference[];
  document: BlissHackProfileExportV1;
  profile: BlissHackProfileV1;
}

interface ConfirmationDialogProps {
  confirmLabel: string;
  message: string;
  onCancel(): void;
  onConfirm(): void;
  returnFocusRef: RefObject<HTMLElement | null>;
  title: string;
}

/** Render a destructive or state-replacing Settings confirmation. */
export function ConfirmationDialog({
  confirmLabel,
  message,
  onCancel,
  onConfirm,
  returnFocusRef,
  title,
}: ConfirmationDialogProps) {
  return (
    <SettingsModal
      alert
      label={title}
      onCancel={onCancel}
      returnFocusRef={returnFocusRef}
    >
      <h2>{title}</h2>
      <p>{message}</p>
      <div className="settings-modal-actions">
        <button
          autoFocus
          data-modal-initial-focus
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button className="settings-danger" onClick={onConfirm} type="button">
          {confirmLabel}
        </button>
      </div>
    </SettingsModal>
  );
}

interface ImportPreviewDialogProps {
  onCancel(): void;
  onConfirm(): void;
  preview: ImportPreview;
  returnFocusRef: RefObject<HTMLElement | null>;
}

/** Render a reviewed profile import without applying it immediately. */
export function ImportPreviewDialog({
  onCancel,
  onConfirm,
  preview,
  returnFocusRef,
}: ImportPreviewDialogProps) {
  return (
    <SettingsModal
      className="settings-import-preview"
      label="Import profile"
      onCancel={onCancel}
      returnFocusRef={returnFocusRef}
    >
      <h2>Import profile</h2>
      <dl className="settings-import-meta">
        <div><dt>Version</dt><dd>{preview.document.productVersion}</dd></div>
        <div>
          <dt>Exported</dt>
          <dd>{formatExportTime(preview.document.exportedAt)}</dd>
        </div>
      </dl>
      {preview.differences.length === 0
        ? <p>No settings differ.</p>
        : (
          <div className="settings-differences">
            <div className="settings-difference-heading">
              <span>Setting</span><span>Current</span><span>Incoming</span>
            </div>
            {preview.differences.map((difference) => (
              <div key={difference.path}>
                <strong>{difference.label}</strong>
                <span>{difference.current}</span>
                <span>{difference.incoming}</span>
              </div>
            ))}
          </div>
        )}
      <div className="settings-modal-actions">
        <button
          autoFocus
          data-modal-initial-focus
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          className="settings-primary"
          disabled={preview.differences.length === 0}
          onClick={onConfirm}
          type="button"
        >
          Import
        </button>
      </div>
    </SettingsModal>
  );
}

function formatExportTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
