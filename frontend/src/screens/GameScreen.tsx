import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  getSnapshot,
  subscribe,
  type GameSnapshot,
} from "../game-state";
import { keyboardEventToNetHackKey } from "../keyboard";
import {
  validateProfile,
  type BlissHackProfileV1,
} from "../settings/profile";
import type { ProfileLoadStatus } from "../settings/profile-store";
import {
  dismissDisplay,
  queueRuntimeSettings,
  requestSaveAndExit,
  sendKey,
} from "../nethack-bridge";
import { SettingsScreen } from "./SettingsScreen";
import { GameModalRenderer } from "./game/GameModals";
import { GameTerminal } from "./game/GameTerminal";
import { PauseOverlay } from "./game/PauseOverlay";

interface GameScreenProps {
  loadStatus: ProfileLoadStatus;
  moduleId: string;
  onApplyProfile(profile: BlissHackProfileV1): Promise<BlissHackProfileV1>;
  profile: BlissHackProfileV1;
}

/**
 * Render and operate the active character-mode NetHack session.
 * @param props - active profile and persistence boundary.
 * @returns the complete game terminal.
 */
export function GameScreen({
  loadStatus,
  moduleId,
  onApplyProfile,
  profile,
}: GameScreenProps) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [pauseView, setPauseView] = useState<"pause" | "settings" | null>(null);
  const previousRuntimeSettings = useRef<string | null>(null);
  const settings = profile.interface;
  const gameProfile = useMemo(
    () => profileWithRuntimeSettings(profile, snapshot.runtimeSettings),
    [profile, snapshot.runtimeSettings],
  );

  useEffect(() => {
    const current = snapshot.runtimeSettings;
    if (!current) return;
    const serialized = JSON.stringify(current);
    const previous = previousRuntimeSettings.current;
    previousRuntimeSettings.current = serialized;
    if (
      previous === null
      || previous === serialized
      || snapshot.runtimeSettingsStatus !== "idle"
    ) {
      return;
    }
    void onApplyProfile(profileWithRuntimeSettings(profile, current))
      .catch(() => {
        // The current core value remains authoritative for this session.
      });
  }, [
    onApplyProfile,
    profile,
    snapshot.runtimeSettings,
    snapshot.runtimeSettingsStatus,
  ]);

  useEffect(() => {
    /**
     * Route a browser key to the active NetHack callback.
     * @param event - browser keyboard event.
     */
    function handleKeyDown(event: KeyboardEvent): void {
      if (pauseView !== null) return;
      if (snapshot.inputRequest?.kind === "line") return;
      if (
        event.target instanceof Element
        && event.target.closest("[data-browser-keyboard]")
      ) {
        return;
      }
      if (snapshot.modal?.kind === "menu" || snapshot.modal?.kind === "extcmd") {
        return;
      }
      const value = keyboardEventToNetHackKey(event, {
        numberPad: snapshot.numberPad,
      });
      if (value === null) return;
      event.preventDefault();
      if (
        value === 27
        && !event.repeat
        && snapshot.commandInput
        && snapshot.modal === null
      ) {
        setPauseView("pause");
        return;
      }
      if (snapshot.modal?.kind === "text" || snapshot.modal?.kind === "history") {
        dismissDisplay();
        return;
      }
      sendKey(value);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    pauseView,
    snapshot.commandInput,
    snapshot.inputRequest,
    snapshot.modal,
    snapshot.numberPad,
  ]);

  /** Persist game settings, queue the dynamic subset, and advance one safe boundary. */
  async function applyGameProfile(
    candidate: BlissHackProfileV1,
  ): Promise<BlissHackProfileV1> {
    const saved = await onApplyProfile(candidate);
    queueRuntimeSettings(saved.nethack);
    sendKey(27);
    return saved;
  }

  /** Persist the panel collapse preference without entering the WASM runtime. */
  function setInventoryCollapsed(collapsed: boolean): void {
    void onApplyProfile(validateProfile({
      ...gameProfile,
      interface: {
        ...gameProfile.interface,
        permanentInventoryCollapsed: collapsed,
      },
    })).catch(() => {
      // Keep the current profile when browser persistence rejects the update.
    });
  }

  /**
   * Return keyboard ownership to the game when its non-browser UI is clicked.
   * @param event - mouse event captured by the active game shell.
   */
  function handleGameMouseDown(event: ReactMouseEvent<HTMLElement>): void {
    if (
      event.target instanceof Element
      && event.target.closest("[data-browser-keyboard]")
    ) {
      return;
    }
    const active = document.activeElement;
    if (
      active instanceof HTMLElement
      && active.closest("[data-browser-keyboard]")
    ) {
      active.blur();
    }
  }

  return (
    <main
      className={`nh-shell nh-font-${settings.terminalFontSize}`}
      data-command-input={snapshot.commandInput ? "ready" : "busy"}
      data-number-pad={snapshot.numberPad ? "on" : "off"}
      data-settings-status={snapshot.runtimeSettingsStatus}
      aria-label="BlissHack"
      onMouseDownCapture={handleGameMouseDown}
    >
      <header className="nh-header">
        <strong>BlissHack</strong>
        <span className={`nh-runtime nh-runtime-${snapshot.phase}`}>
          {runtimeLabel(snapshot)}
        </span>
      </header>

      {snapshot.phase === "error" ? (
        <section className="nh-fatal" role="alert">
          {snapshot.error}
        </section>
      ) : (
        <GameTerminal
          clipCenter={snapshot.clipCenter}
          cursor={snapshot.cursor}
          followPlayer={settings.followPlayer}
          historyLines={settings.messageHistoryLines}
          inert={snapshot.modal !== null || pauseView !== null}
          inputRequest={snapshot.inputRequest}
          layoutKey={`${settings.terminalFontSize}:${settings.messageHistoryLines}`}
          map={snapshot.map}
          messages={snapshot.messages}
          onInventoryCollapsedChange={setInventoryCollapsed}
          permanentInventory={snapshot.permanentInventory}
          permanentInventoryCollapsed={settings.permanentInventoryCollapsed}
          permanentInventoryEnabled={gameProfile.nethack.permInvent}
          permanentInventoryPosition={settings.permanentInventoryPosition}
          status={snapshot.status}
        />
      )}

      {snapshot.modal && <GameModalRenderer modal={snapshot.modal} />}
      {pauseView === "pause" && (
        <PauseOverlay
          ready={
            snapshot.commandInput
            && snapshot.runtimeSettingsStatus !== "pending"
          }
          onResume={() => setPauseView(null)}
          onSaveAndExit={() => {
            setPauseView(null);
            requestSaveAndExit();
          }}
          onSettings={() => setPauseView("settings")}
        />
      )}
      {pauseView === "settings" && (
        <SettingsScreen
          context="game"
          loadStatus={loadStatus}
          moduleId={moduleId}
          onApply={applyGameProfile}
          onBack={() => setPauseView("pause")}
          profile={gameProfile}
        />
      )}
    </main>
  );
}

/**
 * Replace dynamic NetHack fields with the core's authoritative current values.
 * @param profile - persisted personal defaults.
 * @param runtimeSettings - current core snapshot, or null before startup.
 * @returns a complete profile suitable for the shared Settings form.
 */
function profileWithRuntimeSettings(
  profile: BlissHackProfileV1,
  runtimeSettings: GameSnapshot["runtimeSettings"],
): BlissHackProfileV1 {
  if (!runtimeSettings) return validateProfile(profile);
  return validateProfile({
    ...profile,
    nethack: {
      tutorial: profile.nethack.tutorial,
      ...runtimeSettings,
    },
  });
}

/**
 * Convert a runtime phase into a compact status label.
 * @param snapshot - current game snapshot.
 * @returns user-facing runtime state.
 */
function runtimeLabel(snapshot: GameSnapshot): string {
  if (snapshot.phase === "loading") return "Loading";
  if (snapshot.phase === "running") return "Running";
  if (snapshot.phase === "exited") return snapshot.exitReason || "Exited";
  if (snapshot.phase === "error") return "Error";
  return "Idle";
}

export default GameScreen;
