import { useState, type ChangeEvent } from "react";
import { Download, Trash2, Upload } from "lucide-react";
import type { HomeSaveImportResult } from "../session/session-manager";
import {
  MAX_RAW_SAVE_BYTES,
  saveValidationMessage,
  type RawSaveImportRequest,
  type RawSaveImportResult,
  type RawSaveSummary,
  type SaveListEntry,
} from "../storage/storage-service";
import { GameLockCancelledError } from "../concurrency/game-lock";

/** Properties for the saved-game popover anchored to Continue. */
interface SavePickerPopoverProps {
  id?: string;
  moduleId: string;
  onContinue: (save: SaveListEntry) => void;
  onDelete?: (save: SaveListEntry) => Promise<void>;
  onDismiss?: () => void;
  onExport?: (save: SaveListEntry) => Promise<void>;
  onImport?: (
    request: RawSaveImportRequest,
  ) => Promise<HomeSaveImportResult>;
  saves: SaveListEntry[];
}

interface DeleteError {
  message: string;
  path: string;
}

/**
 * Render saves without replacing the surrounding home screen.
 * @param props - current module identity, saves, and selection handler.
 * @returns a compact saved-game popover.
 */
export function SavePickerPopover({
  id,
  moduleId,
  onContinue,
  onDelete = async () => undefined,
  onDismiss = () => undefined,
  onExport = async () => undefined,
  onImport = async () => {
    throw new Error("Raw save import is unavailable");
  },
  saves,
}: SavePickerPopoverProps) {
  const [confirmingPath, setConfirmingPath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<DeleteError | null>(null);
  const [transferPending, setTransferPending] = useState(false);
  const [importSuccessSerial, setImportSuccessSerial] = useState<number | null>(
    null,
  );
  const [importConflict, setImportConflict] = useState<{
    conflict: Extract<RawSaveImportResult, { status: "conflict" }>;
    request: RawSaveImportRequest;
  } | null>(null);
  const [operationError, setOperationError] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const busy = deletingPath !== null || transferPending;

  /** Confirm on the first click and delete on the second click. */
  async function requestDelete(save: SaveListEntry): Promise<void> {
    if (deletingPath !== null) return;
    setDeleteError(null);
    if (confirmingPath !== save.path) {
      setConfirmingPath(save.path);
      return;
    }

    setDeletingPath(save.path);
    try {
      await onDelete(save);
      setConfirmingPath(null);
    } catch (error) {
      if (!(error instanceof GameLockCancelledError)) {
        setConfirmingPath(null);
        setDeleteError({
          path: save.path,
          message: deleteErrorMessage(error),
        });
      }
    } finally {
      setDeletingPath(null);
    }
  }

  /** Read and validate one browser-selected file through the Home manager. */
  async function importSelectedFile(
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file || transferPending) return;
    if (file.size === 0 || file.size > MAX_RAW_SAVE_BYTES) {
      setOperationError({
        title: "Import failed",
        message: file.size === 0
          ? "Save file is empty"
          : "Save file exceeds the 64 MiB limit",
      });
      return;
    }

    setTransferPending(true);
    try {
      const request: RawSaveImportRequest = {
        bytes: new Uint8Array(await file.arrayBuffer()),
        modifiedAt: Number.isFinite(file.lastModified)
          ? file.lastModified
          : null,
        overwrite: false,
      };
      const result = await onImport(request);
      if (result.status === "conflict") {
        setImportConflict({ conflict: result, request });
      } else {
        setImportSuccessSerial((serial) => (serial ?? 0) + 1);
      }
    } catch (error) {
      if (!(error instanceof GameLockCancelledError)) {
        setOperationError({
          title: "Import failed",
          message: operationErrorMessage(error, "Could not import save"),
        });
      }
    } finally {
      setTransferPending(false);
    }
  }

  /** Retry the retained import only after explicit overwrite confirmation. */
  async function overwriteImportedSave(): Promise<void> {
    if (!importConflict || transferPending) return;
    setTransferPending(true);
    try {
      const result = await onImport({
        ...importConflict.request,
        expectedExisting: importConflict.conflict.existing,
        overwrite: true,
      });
      if (result.status === "conflict") {
        setImportConflict({
          conflict: result,
          request: {
            ...importConflict.request,
            expectedExisting: undefined,
            overwrite: false,
          },
        });
        return;
      }
      setImportConflict(null);
      setImportSuccessSerial((serial) => (serial ?? 0) + 1);
    } catch (error) {
      if (!(error instanceof GameLockCancelledError)) {
        setImportConflict(null);
        setOperationError({
          title: "Import failed",
          message: operationErrorMessage(error, "Could not replace save"),
        });
      }
    } finally {
      setTransferPending(false);
    }
  }

  /** Request one raw save download without changing its stored bytes. */
  async function exportSelectedSave(save: SaveListEntry): Promise<void> {
    if (busy) return;
    setTransferPending(true);
    try {
      await onExport(save);
    } catch (error) {
      if (!(error instanceof GameLockCancelledError)) {
        setOperationError({
          title: "Export failed",
          message: operationErrorMessage(error, "Could not export save"),
        });
      }
    } finally {
      setTransferPending(false);
    }
  }

  return (
    <div
      aria-label="Saved games"
      className="save-picker-popover"
      data-module-id={moduleId}
      id={id}
      role="dialog"
    >
      <div className="save-picker-heading">Saved games</div>
      <div className="save-import-control">
        {importSuccessSerial !== null && (
          <span
            className="save-import-success"
            key={importSuccessSerial}
            role="status"
          >
            Import successful
          </span>
        )}
        <button
          className="save-import-button"
          disabled={busy}
          onClick={(event) => {
            const input = event.currentTarget.nextElementSibling;
            if (input instanceof HTMLInputElement) input.click();
          }}
          type="button"
        >
          <Upload aria-hidden="true" size={17} strokeWidth={2} />
          <span>Import save</span>
        </button>
        <input
          aria-label="Import save file"
          className="save-import-input"
          disabled={busy}
          onChange={(event) => void importSelectedFile(event)}
          type="file"
        />
      </div>
      <div className="save-picker-list">
        {saves.length === 0 && (
          <p className="save-picker-empty">No saved games</p>
        )}
        {saves.map((save) => {
          const ready = save.status === "ready";
          const label = ready
            ? save.identity.playerName
            : fileLabel(save.path);
          const confirming = confirmingPath === save.path;
          const deleting = deletingPath === save.path;
          const error = deleteError?.path === save.path
            ? deleteError.message
            : null;
          return (
            <div
              className={`save-picker-entry${ready ? "" : " save-picker-entry-invalid"}`}
              key={save.path}
            >
              <button
                className="save-picker-choice"
                disabled={!ready}
                onClick={() => {
                  if (ready) onContinue(save);
                }}
                type="button"
              >
                <span>{label}</span>
                <small>
                  {ready
                    ? [
                      save.identity.role,
                      save.identity.race,
                      save.identity.gender,
                      save.identity.alignment,
                    ].join(" · ")
                    : saveValidationMessage(save)}
                </small>
              </button>
              <div className="save-export-control">
                <button
                  aria-label={`Export save ${label}`}
                  className="save-export-button"
                  disabled={busy}
                  onClick={() => void exportSelectedSave(save)}
                  title={`Export save ${label}`}
                  type="button"
                >
                  <Download aria-hidden="true" size={18} strokeWidth={2} />
                </button>
              </div>
              <div className="save-delete-control">
                {confirming && !deleting && (
                  <span className="save-delete-confirmation">Sure?</span>
                )}
                <button
                  aria-label={`Delete save ${label}`}
                  className="save-delete-button"
                  disabled={busy}
                  onClick={() => void requestDelete(save)}
                  title={`Delete save ${label}`}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={18} strokeWidth={2} />
                </button>
              </div>
              {error && (
                <small className="save-delete-error" role="alert">
                  {error}
                </small>
              )}
            </div>
          );
        })}
      </div>
      {importConflict && (
        <SaveConflictDialog
          conflict={importConflict.conflict}
          onCancel={() => setImportConflict(null)}
          onOverwrite={() => void overwriteImportedSave()}
          pending={transferPending}
        />
      )}
      {operationError && (
        <SaveImportErrorDialog
          message={operationError.message}
          onConfirm={() => {
            setOperationError(null);
            onDismiss();
          }}
          title={operationError.title}
        />
      )}
    </div>
  );
}

interface SaveConflictDialogProps {
  conflict: Extract<RawSaveImportResult, { status: "conflict" }>;
  onCancel: () => void;
  onOverwrite: () => void;
  pending: boolean;
}

/** Render the explicit same-name replacement decision. */
export function SaveConflictDialog({
  conflict,
  onCancel,
  onOverwrite,
  pending,
}: SaveConflictDialogProps) {
  return (
    <div
      className="save-modal-backdrop"
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <section
        aria-label="Save conflict"
        aria-modal="true"
        className="save-modal"
        role="dialog"
      >
        <h2>Save conflict</h2>
        <p>A save for this character already exists. Choose Cancel or Overwrite.</p>
        <div className="save-conflict-comparison">
          <SaveSummary label="Existing" summary={conflict.existing} />
          <SaveSummary label="Incoming" summary={conflict.incoming} />
        </div>
        <div className="save-modal-actions">
          <button autoFocus disabled={pending} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="save-modal-danger"
            disabled={pending}
            onClick={onOverwrite}
            type="button"
          >
            Overwrite
          </button>
        </div>
      </section>
    </div>
  );
}

interface SaveImportErrorDialogProps {
  message: string;
  onConfirm: () => void;
  title?: string;
}

/** Render an acknowledged import or export failure. */
export function SaveImportErrorDialog({
  message,
  onConfirm,
  title = "Import failed",
}: SaveImportErrorDialogProps) {
  return (
    <div
      className="save-modal-backdrop"
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <section
        aria-label={title}
        aria-modal="true"
        className="save-modal"
        role="alertdialog"
      >
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="save-modal-actions">
          <button autoFocus onClick={onConfirm} type="button">OK</button>
        </div>
      </section>
    </div>
  );
}

/** Render one side of a raw-save conflict comparison. */
function SaveSummary({
  label,
  summary,
}: {
  label: string;
  summary: RawSaveSummary;
}) {
  return (
    <section className="save-summary">
      <h3>{label}</h3>
      <dl>
        <div><dt>Name</dt><dd>{summary.identity.playerName}</dd></div>
        <div><dt>Saved</dt><dd>{formatFileTime(summary.modifiedAt)}</dd></div>
        <div><dt>Role</dt><dd>{summary.identity.role}</dd></div>
        <div><dt>Race</dt><dd>{summary.identity.race}</dd></div>
        <div><dt>Gender</dt><dd>{summary.identity.gender}</dd></div>
        <div><dt>Alignment</dt><dd>{summary.identity.alignment}</dd></div>
      </dl>
    </section>
  );
}

/** Derive a non-authoritative label for an invalid candidate path. */
function fileLabel(path: string): string {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  return fileName.startsWith("0") ? fileName.slice(1) : fileName;
}

/** Convert an unknown deletion failure into concise UI text. */
function deleteErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not delete save";
}

/** Format untrusted file metadata without treating it as save content. */
function formatFileTime(modifiedAt: number | null): string {
  if (modifiedAt === null) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(modifiedAt));
}

/** Normalize an unknown operation failure for a visible dialog. */
function operationErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
