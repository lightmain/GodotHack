import {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

interface SettingsModalProps {
  alert?: boolean;
  children: ReactNode;
  className?: string;
  label: string;
  onCancel?: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Render a portal-backed Settings modal with focus containment and restoration.
 * @param props - modal semantics, content, and optional Escape cancellation.
 * @returns an accessible modal isolated from the Settings screen.
 */
export function SettingsModal({
  alert = false,
  children,
  className = "",
  label,
  onCancel,
  returnFocusRef,
}: SettingsModalProps) {
  const ref = useRef<HTMLElement>(null);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const modal = ref.current;
    if (!modal) return undefined;
    const trigger = returnFocusRef?.current
      ?? (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    const settingsScreen = document.querySelector<HTMLElement>(
      ".settings-screen",
    );
    if (settingsScreen) settingsScreen.inert = true;
    const initial = modal.querySelector<HTMLElement>(
      "[data-modal-initial-focus]",
    ) ?? modal.querySelector<HTMLElement>("button, input, select, textarea");
    initial?.focus();

    /** Keep keyboard focus and Escape handling inside the active modal. */
    function containFocus(event: KeyboardEvent): void {
      if (event.key === "Escape" && onCancelRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(modal!.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), "
          + "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ));
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
      globalThis.setTimeout(() => {
        if (
          trigger?.isConnected
          && !document.querySelector("[aria-modal='true']")
        ) {
          trigger.focus();
        }
      }, 0);
    };
  }, [returnFocusRef]);

  const modal = (
    <div className="settings-modal-backdrop">
      <section
        aria-label={label}
        aria-modal="true"
        className={`settings-modal${className ? ` ${className}` : ""}`}
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
