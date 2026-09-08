import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface GameLockConflictDialogProps {
  pending: boolean;
  requestFailed?: boolean;
  onCancel(): void;
  onRetry(): void;
}

/**
 * Explain one cross-page lock conflict and let the player retry explicitly.
 * @param props - pending state and application-owned retry controls.
 * @returns an accessible application-level modal.
 */
export function GameLockConflictDialog({
  pending,
  requestFailed = false,
  onCancel,
  onRetry,
}: GameLockConflictDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef(onCancel);
  const pendingRef = useRef(pending);

  useEffect(() => {
    cancelRef.current = onCancel;
    pendingRef.current = pending;
  }, [onCancel, pending]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (!dialog) return undefined;
    const activeDialog = dialog;
    const background = document.querySelector<HTMLElement>("body > #root");
    if (background) background.inert = true;
    dialog.querySelector<HTMLElement>("[data-modal-initial-focus]")?.focus();

    function handleKey(event: KeyboardEvent): void {
      if (event.key === "Escape" && !pendingRef.current) {
        event.preventDefault();
        event.stopPropagation();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(activeDialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ));
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls.at(-1) as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    dialog.addEventListener("keydown", handleKey);
    return () => {
      dialog.removeEventListener("keydown", handleKey);
      if (background) background.inert = false;
      globalThis.setTimeout(() => trigger?.focus(), 0);
    };
  }, []);

  const modal = (
    <div className="settings-modal-backdrop">
      <section
        aria-label={requestFailed
          ? "BlissHack could not coordinate browser pages"
          : "BlissHack is busy in another page"}
        aria-modal="true"
        className="settings-modal game-lock-dialog"
        ref={dialogRef}
        role="alertdialog"
      >
        <h2>
          {requestFailed
            ? "BlissHack could not coordinate browser pages"
            : "BlissHack is busy in another page"}
        </h2>
        <p>
          {requestFailed
            ? "The browser could not protect this operation. Try again or use only one BlissHack page."
            : "Another BlissHack page is running a game or changing local data. Close it or finish that operation, then try again."}
        </p>
        <div className="settings-modal-actions">
          <button
            data-modal-initial-focus
            disabled={pending}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button disabled={pending} onClick={onRetry} type="button">
            Try Again
          </button>
        </div>
      </section>
    </div>
  );
  return typeof document === "undefined"
    ? modal
    : createPortal(modal, document.body);
}
