import { useEffect } from "react";
import { Play, Save, Settings } from "lucide-react";

interface PauseOverlayProps {
  onResume(): void;
  onSaveAndExit(): void;
  onSettings(): void;
  ready: boolean;
}

/**
 * Render commands which leave the core blocked on its current input promise.
 * @param props - resume, settings, and native save command callbacks.
 * @returns the pause dialog.
 */
export function PauseOverlay({
  onResume,
  onSaveAndExit,
  onSettings,
  ready,
}: PauseOverlayProps) {
  useEffect(() => {
    /** Resume the game from the pause layer without sending Esc to NetHack. */
    function handleEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onResume();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onResume]);

  return (
    <div className="nh-pause-backdrop">
      <section
        aria-label="Game paused"
        aria-modal="true"
        className="nh-pause"
        role="dialog"
      >
        <header>
          <span>BlissHack</span>
          <h1>Paused</h1>
        </header>
        <div className="nh-pause-actions">
          <button autoFocus disabled={!ready} onClick={onResume} type="button">
            <Play aria-hidden="true" size={18} />
            Resume
          </button>
          <button disabled={!ready} onClick={onSettings} type="button">
            <Settings aria-hidden="true" size={18} />
            Settings
          </button>
          <button
            className="nh-pause-save"
            disabled={!ready}
            onClick={onSaveAndExit}
            type="button"
          >
            <Save aria-hidden="true" size={18} />
            Save and Exit
          </button>
          {!ready && <span role="status">Applying settings</span>}
        </div>
      </section>
    </div>
  );
}
