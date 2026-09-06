import { useEffect, useRef } from "react";
import type { HomeSaveImportResult } from "../session/session-manager";
import type {
  RawSaveImportRequest,
  SaveListEntry,
} from "../storage/storage-service";
import { PRODUCT_VERSION } from "../version";
import { SavePickerPopover } from "./SavePickerPopover";

/** Properties for the application home screen. */
interface HomeScreenProps {
  hasSaves?: boolean;
  moduleId?: string;
  onContinue?: () => void;
  onContinueSave?: (save: SaveListEntry) => void;
  onDeleteSave?: (save: SaveListEntry) => Promise<void>;
  onDismissSavePicker?: () => void;
  onExportDiagnostics?: () => void;
  onExportSave?: (save: SaveListEntry) => Promise<void>;
  onImportSave?: (
    request: RawSaveImportRequest,
  ) => Promise<HomeSaveImportResult>;
  onNewGame: () => void;
  onSettings?: () => void;
  savePickerOpen?: boolean;
  saves?: SaveListEntry[];
  storageAvailable?: boolean;
}

/**
 * Render the BlissHack command screen without creating a WASM session.
 * @param props - home-screen command handlers.
 * @returns the application home screen.
 */
export function HomeScreen({
  moduleId = "home",
  onContinue = () => undefined,
  onContinueSave = () => undefined,
  onDeleteSave = async () => undefined,
  onDismissSavePicker = () => undefined,
  onExportDiagnostics = () => undefined,
  onExportSave = async () => undefined,
  onImportSave = async () => {
    throw new Error("Raw save import is unavailable");
  },
  onNewGame,
  onSettings = () => undefined,
  savePickerOpen = false,
  saves = [],
  storageAvailable = true,
}: HomeScreenProps) {
  const continueRegionRef = useRef<HTMLDivElement>(null);
  const savePickerId = "home-save-picker";

  useEffect(() => {
    if (!savePickerOpen) return undefined;

    const dismissOutside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node
        && !continueRegionRef.current?.contains(event.target)
      ) {
        onDismissSavePicker();
      }
    };
    const dismissWithEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onDismissSavePicker();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissWithEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissWithEscape);
    };
  }, [onDismissSavePicker, savePickerOpen]);

  return (
    <main className="home-screen" aria-labelledby="home-title">
      <header className="home-header">
        <span className="home-version">{PRODUCT_VERSION}</span>
        <span className="home-runtime">NetHack 5.0</span>
      </header>

      <section className="home-main">
        <nav aria-label="Main commands" className="home-commands">
          <button onClick={onNewGame} type="button">New Game</button>
          <div className="home-command-slot" ref={continueRegionRef}>
            <button
              aria-controls={savePickerId}
              aria-expanded={savePickerOpen}
              aria-haspopup="dialog"
              disabled={!storageAvailable}
              onClick={savePickerOpen ? onDismissSavePicker : onContinue}
              type="button"
            >
              Continue
            </button>
            {savePickerOpen && (
              <SavePickerPopover
                id={savePickerId}
                moduleId={moduleId}
                onContinue={onContinueSave}
                onDelete={onDeleteSave}
                onDismiss={onDismissSavePicker}
                onExport={onExportSave}
                onImport={onImportSave}
                saves={saves}
              />
            )}
          </div>
          <button onClick={onSettings} type="button">Settings</button>
        </nav>

        <div className="home-identity">
          <div aria-hidden="true" className="home-mark">
            <span>@</span>
            <span>·</span>
            <span>&gt;</span>
          </div>
          <h1 id="home-title">BlissHack</h1>
          <p>An unofficial NetHack 5.0 port</p>
        </div>
        {!storageAvailable && (
          <p className="home-storage-warning" role="status">
            Persistent storage is unavailable. New games are temporary.
          </p>
        )}
      </section>

      <footer className="home-footer">
        <span>BlissHack {PRODUCT_VERSION}</span>
        <span>NetHack copyright 1985-2026</span>
        <button onClick={onExportDiagnostics} type="button">
          Export Diagnostic Log
        </button>
        <a
          href="https://www.nethack.org/common/license.html"
          rel="noreferrer"
          target="_blank"
        >
          License
        </a>
      </footer>
    </main>
  );
}
