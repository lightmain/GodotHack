import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
} from "react";
import {
  Play,
  Save,
  Settings,
} from "lucide-react";
import "../App.css";
import {
  BL_CONDITION,
  PICK_ANY,
  PICK_NONE,
  PICK_ONE,
  getSnapshot,
  getWindow,
  subscribe,
  type GameModal,
  type GameSnapshot,
  type MapCell,
  type MenuItem,
  type StatusValue,
  type TextLine,
  type WindowState,
} from "../game-state";
import { keyboardEventToNetHackKey } from "../keyboard";
import {
  buildMapRuns,
  mapFollowOffset,
  mapPositionFromPoint,
} from "../map-rendering";
import { buildHitPointBar } from "../status-rendering";
import {
  validateProfile,
  type BlissHackProfileV1,
  type InterfaceSettingsV1,
} from "../settings/profile";
import type { ProfileLoadStatus } from "../settings/profile-store";
import {
  dismissDisplay,
  normalizePlayerNameInput,
  queueRuntimeSettings,
  requestSaveAndExit,
  sendKey,
  sendPosition,
  submitExtendedCommand,
  submitLine,
  submitMenuSelection,
} from "../nethack-bridge";
import { colorClass, textAttributeClass } from "../text-styling";
import { SettingsScreen } from "./SettingsScreen";
import { PermanentInventoryPanel } from "./PermanentInventoryPanel";

const CONDITION_NAMES = [
  "Bare",
  "Blind",
  "Busy",
  "Conf",
  "Deaf",
  "Iron",
  "Fly",
  "FoodPois",
  "Glow",
  "Grab",
  "Hallu",
  "Held",
  "Icy",
  "Lava",
  "Lev",
  "Parlyz",
  "Ride",
  "Sleep",
  "Slime",
  "Slippery",
  "Stone",
  "Strngl",
  "Stun",
  "Submerged",
  "TermIll",
  "Tethered",
  "Trapped",
  "Unconsc",
  "Wounded",
  "Holding",
] as const;

const STATUS_LINE_ONE = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const STATUS_LINE_TWO = [20, 10, 18, 19, 11, 12, 14, 13, 21, 15, 16, 17, 9] as const;
const STATUS_LINE_THREE = [23, 24, 25, 26] as const;

const AUTO_ACCELERATORS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

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
        <section
          aria-label="NetHack terminal"
          className="nh-terminal"
          inert={snapshot.modal !== null || pauseView !== null}
        >
          <MessageArea
            historyLines={settings.messageHistoryLines}
            messages={snapshot.messages}
          />
          <div
            className={`nh-playfield nh-playfield-${settings.permanentInventoryPosition}`}
          >
            <div className="nh-playfield-main">
              <MapGrid
                clipCenter={snapshot.clipCenter}
                cursor={snapshot.cursor}
                followPlayer={settings.followPlayer}
                layoutKey={`${settings.terminalFontSize}:${settings.messageHistoryLines}`}
                map={snapshot.map}
              />
              <StatusArea status={snapshot.status} />
              <InputArea request={snapshot.inputRequest} />
            </div>
            {gameProfile.nethack.permInvent
              && snapshot.permanentInventory && (
              <PermanentInventoryPanel
                collapsed={settings.permanentInventoryCollapsed}
                inventory={snapshot.permanentInventory}
                onCollapsedChange={setInventoryCollapsed}
                position={settings.permanentInventoryPosition}
              />
            )}
          </div>
        </section>
      )}

      {snapshot.modal && <ModalRenderer modal={snapshot.modal} />}
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
 * Render commands which leave the core blocked on its current input promise.
 * @param props - resume, settings, and native save command callbacks.
 * @returns the pause dialog.
 */
function PauseOverlay({
  onResume,
  onSaveAndExit,
  onSettings,
  ready,
}: {
  onResume(): void;
  onSaveAndExit(): void;
  onSettings(): void;
  ready: boolean;
}) {
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

/**
 * Render the recent NetHack message stream.
 * @param props - current game snapshot.
 * @returns message region.
 */
const MessageArea = memo(function MessageArea({
  historyLines,
  messages: allMessages,
}: {
  historyLines: InterfaceSettingsV1["messageHistoryLines"];
  messages: TextLine[];
}) {
  const messages = allMessages.slice(-historyLines);
  return (
    <section
      className={`nh-messages nh-messages-${historyLines}`}
      aria-live="polite"
      aria-label="Messages"
    >
      {messages.length === 0
        ? <div className="nh-message">&nbsp;</div>
        : messages.map((line, index) => (
          <div
            className={textAttributeClass(line.attribute)}
            key={`${index}:${line.text}`}
          >
            {line.text || "\u00a0"}
          </div>
        ))}
    </section>
  );
});

/**
 * Render the fixed NetHack character map and route mouse clicks to nh_poskey.
 * @param props - current game snapshot.
 * @returns the 80 by 21 map grid.
 */
const MapGrid = memo(function MapGrid({
  clipCenter,
  cursor,
  followPlayer,
  layoutKey,
  map,
}: {
  clipCenter: GameSnapshot["clipCenter"];
  cursor: GameSnapshot["cursor"];
  followPlayer: boolean;
  layoutKey: string;
  map: MapCell[][];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || !followPlayer || !clipCenter) return;

    function centerPlayer(): void {
      if (!viewport || !clipCenter) return;
      const offset = mapFollowOffset(clipCenter.x, clipCenter.y, viewport);
      viewport.scrollLeft = offset.left;
      viewport.scrollTop = offset.top;
    }

    centerPlayer();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(centerPlayer);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [clipCenter, followPlayer, layoutKey]);

  /**
   * Submit a primary or secondary map click while nh_poskey is pending.
   * @param event - delegated mouse event from a map cell.
   */
  function handleMouseDown(event: ReactMouseEvent<HTMLDivElement>): void {
    if (getSnapshot().inputRequest?.kind !== "position") return;
    const position = mapPositionFromPoint(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    );
    if (!position) return;
    event.preventDefault();
    sendPosition(position.x, position.y, event.button === 2 ? 2 : 1);
  }

  /**
   * Suppress the browser context menu while NetHack is accepting map clicks.
   * @param event - browser context-menu event.
   */
  function handleContextMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    if (getSnapshot().inputRequest?.kind === "position") event.preventDefault();
  }

  return (
    <div className="nh-map-scroll" ref={scrollRef}>
      <div
        className="nh-map"
        aria-label="Dungeon map"
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
      >
        {map.map((row, y) => (
          <MapRow
            cursorX={cursor.visible && cursor.y === y ? cursor.x : -1}
            key={y}
            row={row}
            y={y}
          />
        ))}
      </div>
    </div>
  );
});

/**
 * Render one memoized map row as adjacent equal-style text runs.
 * @param props - row cells, cursor column, and row coordinate.
 * @returns one fixed-width character row.
 */
const MapRow = memo(function MapRow({
  row,
  cursorX,
  y,
}: {
  row: MapCell[];
  cursorX: number;
  y: number;
}) {
  return (
    <div className="nh-map-row" data-y={y}>
      {buildMapRuns(row, cursorX).map((run) => (
        <span
          className={[
            "nh-map-run",
            colorClass(run.color),
            run.cursor ? "nh-cursor" : "",
            run.pet ? "nh-pet" : "",
          ].filter(Boolean).join(" ")}
          data-start={run.start}
          key={run.start}
        >
          {run.text}
        </span>
      ))}
    </div>
  );
});

/**
 * Render status fields in compact terminal rows.
 * @param props - current game snapshot.
 * @returns formatted status area.
 */
const StatusArea = memo(function StatusArea({
  status,
}: {
  status: GameSnapshot["status"];
}) {
  const conditions = statusConditions(status[BL_CONDITION]);
  const title = status[0];
  const hitPoints = status[18];

  return (
    <section className="nh-status" aria-label="Character status">
      <div>
        {title && hitPoints && (
          <StatusTitleBar hitPoints={hitPoints} title={title} />
        )}
        {statusEntries(status, STATUS_LINE_ONE).map(renderStatusField)}
      </div>
      <div>
        {statusEntries(status, STATUS_LINE_TWO).map(renderStatusField)}
        {conditions.map((condition) => (
          <span className="nh-condition" key={condition}>{condition}</span>
        ))}
      </div>
      <div>
        {statusEntries(status, STATUS_LINE_THREE).map(renderStatusField)}
      </div>
    </section>
  );
});

/**
 * Render NetHack's title field as a 30-character HP percentage bar.
 * @param props - title text and BL_HP status metadata.
 * @returns bracketed title with the healthy portion highlighted.
 */
function StatusTitleBar({
  title,
  hitPoints,
}: {
  title: StatusValue;
  hitPoints: StatusValue;
}) {
  const bar = buildHitPointBar(title.text, hitPoints.percent);
  return (
    <span
      aria-label={`${bar.text.trimEnd()}, ${bar.percent}% HP`}
      className={`nh-hp-bar ${textAttributeClass(title.attributes)}`}
    >
      <span aria-hidden="true">[</span>
      <span
        aria-hidden="true"
        className={`nh-hp-fill nh-hp-${bar.tone}`}
      >
        {bar.filled}
      </span>
      <span aria-hidden="true" className="nh-hp-empty">{bar.empty}</span>
      <span aria-hidden="true">]</span>
    </span>
  );
}

/**
 * Select populated status fields in the terminal window port's display order.
 * @param snapshot - current game state.
 * @param fields - ordered BL_* field indexes.
 * @returns populated status entries.
 */
function statusEntries(
  status: GameSnapshot["status"],
  fields: readonly number[],
): Array<{ field: number; value: StatusValue }> {
  return fields.flatMap((field) => {
    const value = status[field];
    return value?.text.trim() ? [{ field, value }] : [];
  });
}

/**
 * Render one status field span.
 * @param entry - numeric field and decoded status value.
 * @returns a styled status fragment.
 */
function renderStatusField(entry: { field: number; value: StatusValue }) {
  return (
    <span
      className={`${colorClass(entry.value.color)} ${textAttributeClass(entry.value.attributes)}`}
      key={entry.field}
    >
      {entry.value.text.trim()}
    </span>
  );
}

/**
 * Decode active condition bits into compact labels.
 * @param status - BL_CONDITION status value.
 * @returns active condition names.
 */
function statusConditions(status: StatusValue | undefined): string[] {
  const mask = status?.conditionMask ?? 0;
  return CONDITION_NAMES.filter((_, index) => (mask & (1 << index)) !== 0);
}

/**
 * Render the active prompt or line editor.
 * @param props - current game snapshot.
 * @returns bottom input region.
 */
const InputArea = memo(function InputArea({
  request,
}: {
  request: GameSnapshot["inputRequest"];
}) {
  if (request?.kind === "line") {
    return (
      <LineInput
        existingSaveNames={request.existingSaveNames ?? []}
        purpose={request.purpose}
        query={request.query}
      />
    );
  }
  if (request?.kind === "yn") {
    const choices = request.choices?.split("\u001b")[0] ?? "";
    const defaultCharacter = request.defaultCode > 0
      ? String.fromCharCode(request.defaultCode)
      : "";
    return (
      <div className="nh-prompt">
        <span>{request.query}</span>
        {choices && <span>[{choices}]</span>}
        {defaultCharacter && <span className="nh-default">{defaultCharacter}</span>}
      </div>
    );
  }
  if (request?.kind === "message") {
    return <div className="nh-prompt">{request.message}</div>;
  }
  return <div className="nh-prompt">&nbsp;</div>;
});

/**
 * Render and submit askname/getlin text input.
 * @param props - prompt purpose and query.
 * @returns a focused terminal input form.
 */
function LineInput({
  existingSaveNames,
  purpose,
  query,
}: {
  existingSaveNames: string[];
  purpose: "name" | "getlin";
  query: string;
}) {
  const [value, setValue] = useState("");
  const continuesExistingSave = purpose === "name"
    && existingSaveNames.includes(normalizePlayerNameInput(value));

  /**
   * Submit the current text value.
   * @param event - form submission event.
   */
  function handleSubmit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): void {
    event.preventDefault();
    submitLine(value);
  }

  /**
   * Cancel a getlin prompt with Escape.
   * @param event - input key event.
   */
  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation();
    if (event.key === "Escape" && purpose === "getlin") {
      event.preventDefault();
      submitLine(null);
    }
  }

  return (
    <form className="nh-line-input" onSubmit={handleSubmit}>
      <label htmlFor="nh-command-input">{query}</label>
      <div className="nh-line-input-field">
        <input
          aria-describedby={continuesExistingSave
            ? "nh-existing-save-hint"
            : undefined}
          autoComplete="off"
          autoFocus
          id="nh-command-input"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          value={value}
        />
        {continuesExistingSave && (
          <span
            className="nh-existing-save-hint"
            id="nh-existing-save-hint"
            role="status"
          >
            A save with this name already exists. The game will continue from
            that save.
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * Select the renderer for the active modal type.
 * @param props - active modal state.
 * @returns the corresponding overlay.
 */
const ModalRenderer = memo(function ModalRenderer({ modal }: { modal: GameModal }) {
  if (modal.kind === "menu") {
    const window = getWindow(modal.windowId);
    return window ? <MenuOverlay how={modal.how} window={window} /> : null;
  }
  if (modal.kind === "extcmd") {
    return <ExtendedCommandOverlay commands={modal.commands} />;
  }
  return (
    <TextOverlay
      lines={modal.lines}
      title={modal.kind === "text" ? modal.title : "Message history"}
    />
  );
});

/**
 * Render a blocking text or history window.
 * @param props - title and styled lines.
 * @returns text overlay.
 */
function TextOverlay({ title, lines }: { title: string; lines: TextLine[] }) {
  return (
    <div className="nh-overlay" role="presentation" onMouseDown={dismissDisplay}>
      <section
        aria-label={title || "Text"}
        className="nh-dialog nh-text-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <strong>{title}</strong>
          <button aria-label="Close" onClick={dismissDisplay} type="button">×</button>
        </header>
        <pre>
          {lines.map((line, index) => (
            <span className={textAttributeClass(line.attribute)} key={`${index}:${line.text}`}>
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      </section>
    </div>
  );
}

/**
 * Render and operate a NetHack PICK_NONE/PICK_ONE/PICK_ANY menu.
 * @param props - menu window and selection mode.
 * @returns menu overlay.
 */
function MenuOverlay({ window, how }: { window: WindowState; how: number }) {
  const rows = useMemo(() => assignAccelerators(window.menuItems), [window.menuItems]);
  const selectableIndexes = useMemo(
    () => rows.filter((row) => row.item.identifier !== null).map((row) => row.index),
    [rows],
  );
  const preselectedIndex = rows.find(
    ({ item }) =>
      item.identifier !== null && (item.itemFlags & 1) !== 0,
  )?.index;
  const [focusIndex, setFocusIndex] = useState(
    preselectedIndex ?? selectableIndexes[0] ?? -1,
  );
  const [selected, setSelected] = useState<Map<number, number>>(() => {
    const initial = new Map<number, number>();
    rows.forEach(({ item, index }) => {
      if (item.identifier !== null && (item.itemFlags & 1) !== 0) {
        initial.set(index, -1);
      }
    });
    return initial;
  });
  const [count, setCount] = useState("");

  useEffect(() => {
    /**
     * Apply NetHack menu commands and accelerators.
     * @param event - browser keyboard event.
     */
    function handleMenuKey(event: KeyboardEvent): void {
      const encoded = keyboardEventToNetHackKey(event, { numberPad: false });
      if (event.key === "Escape") {
        event.preventDefault();
        submitMenuSelection(null);
        return;
      }
      if (how === PICK_NONE) {
        if (encoded !== null) {
          event.preventDefault();
          dismissDisplay();
        }
        return;
      }
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        setCount((current) => `${current}${event.key}`.slice(0, 9));
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setFocusIndex((current) =>
          moveMenuFocus(selectableIndexes, current, event.key === "ArrowDown" ? 1 : -1),
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (how === PICK_ONE && focusIndex >= 0) {
          submitMenuSelection([{ itemIndex: focusIndex, count: parsedCount(count) }]);
        } else {
          submitMenuSelection(
            Array.from(selected, ([itemIndex, itemCount]) => ({
              itemIndex,
              count: itemCount,
            })),
          );
        }
        return;
      }
      if (event.key === " " && focusIndex >= 0) {
        event.preventDefault();
        chooseMenuItem(focusIndex);
        return;
      }
      if (how === PICK_ANY && encoded !== null && [46, 45, 64].includes(encoded)) {
        event.preventDefault();
        applyBulkMenuCommand(encoded);
        return;
      }
      if (encoded === null) return;
      const accelerated = rows.find(
        (row) =>
          row.item.identifier !== null
          && (row.accelerator === encoded || row.item.groupAccelerator === encoded),
      );
      if (!accelerated) return;
      event.preventDefault();
      if (accelerated.item.groupAccelerator === encoded && how === PICK_ANY) {
        toggleMenuGroup(encoded);
      } else {
        chooseMenuItem(accelerated.index);
      }
    }

    windowThis().addEventListener("keydown", handleMenuKey);
    return () => windowThis().removeEventListener("keydown", handleMenuKey);
  });

  /**
   * Select, toggle, or immediately submit one menu row.
   * @param itemIndex - source row index.
   */
  function chooseMenuItem(itemIndex: number): void {
    if (how === PICK_NONE) {
      dismissDisplay();
      return;
    }
    if (how === PICK_ONE) {
      submitMenuSelection([{ itemIndex, count: parsedCount(count) }]);
      return;
    }
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(itemIndex)) next.delete(itemIndex);
      else next.set(itemIndex, parsedCount(count));
      return next;
    });
    setCount("");
    setFocusIndex(itemIndex);
  }

  /**
   * Apply select-all, unselect-all, or invert-all.
   * @param command - NetHack menu command byte.
   */
  function applyBulkMenuCommand(command: number): void {
    setSelected((current) => {
      if (command === 45) return new Map();
      const next = command === 64 ? new Map(current) : new Map<number, number>();
      for (const row of rows) {
        if (row.item.identifier === null || (row.item.itemFlags & 2) !== 0) continue;
        if (command === 64 && next.has(row.index)) next.delete(row.index);
        else next.set(row.index, -1);
      }
      return next;
    });
  }

  /**
   * Toggle all selectable rows sharing one group accelerator.
   * @param groupCode - group accelerator byte.
   */
  function toggleMenuGroup(groupCode: number): void {
    const indexes = rows
      .filter(
        (row) =>
          row.item.identifier !== null
          && row.item.groupAccelerator === groupCode,
      )
      .map((row) => row.index);
    setSelected((current) => {
      const next = new Map(current);
      const allSelected = indexes.every((index) => next.has(index));
      indexes.forEach((index) => {
        if (allSelected) next.delete(index);
        else next.set(index, -1);
      });
      return next;
    });
  }

  return (
    <div className="nh-overlay">
      <section className="nh-dialog nh-menu" role="dialog" aria-label={window.menuPrompt || "Menu"}>
        {window.menuPrompt && <header>{window.menuPrompt}</header>}
        <div className="nh-menu-items">
          {rows.map(({ item, index, accelerator }) =>
            item.identifier === null ? (
              <div
                className={`nh-menu-heading ${textAttributeClass(item.attribute)}`}
                key={`${index}:${item.text}`}
              >
                {item.text || "\u00a0"}
              </div>
            ) : (
              <button
                className={[
                  "nh-menu-item",
                  focusIndex === index ? "focused" : "",
                  selected.has(index) ? "selected" : "",
                  colorClass(item.color),
                  textAttributeClass(item.attribute),
                ].filter(Boolean).join(" ")}
                key={`${index}:${item.text}`}
                onClick={() => chooseMenuItem(index)}
                onMouseEnter={() => setFocusIndex(index)}
                type="button"
              >
                <span aria-hidden="true" className="nh-menu-glyph">
                  {item.glyph?.ttyChar
                    ? String.fromCodePoint(item.glyph.ttyChar)
                    : " "}
                </span>
                <span className="nh-menu-mark">
                  {how === PICK_ANY ? (selected.has(index) ? "+" : "-") : " "}
                </span>
                <span className="nh-menu-accelerator">
                  {accelerator ? String.fromCharCode(accelerator) : " "}
                </span>
                <span className="nh-menu-text">{item.text}</span>
              </button>
            ),
          )}
        </div>
        {count && <output className="nh-count">{count}</output>}
      </section>
    </div>
  );
}

/**
 * Render a searchable extended-command chooser.
 * @param props - parsed extcmdlist entries.
 * @returns extended-command overlay.
 */
function ExtendedCommandOverlay({
  commands,
}: {
  commands: Array<{ sourceIndex: number; name: string; description: string }>;
}) {
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(0);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? commands.filter((command) => command.name.startsWith(normalized))
      : commands;
  }, [commands, query]);

  /**
   * Submit or cancel the extended-command picker.
   * @param event - input key event.
   */
  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      submitExtendedCommand(null);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setFocus((current) => wrapIndex(current + delta, filtered.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const exact = filtered.find((command) => command.name === query.trim().toLowerCase());
      const command = exact ?? filtered[focus];
      if (command) submitExtendedCommand(command.sourceIndex);
    }
  }

  return (
    <div className="nh-overlay">
      <section className="nh-dialog nh-extcmd" role="dialog" aria-label="Extended command">
        <input
          autoComplete="off"
          autoFocus
          onChange={(event) => {
            setQuery(event.target.value);
            setFocus(0);
          }}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          value={query}
        />
        <div className="nh-extcmd-list">
          {filtered.slice(0, 100).map((command, index) => (
            <button
              className={index === focus ? "focused" : ""}
              key={command.sourceIndex}
              onClick={() => submitExtendedCommand(command.sourceIndex)}
              onMouseEnter={() => setFocus(index)}
              type="button"
            >
              <strong>{command.name}</strong>
              <span>{command.description}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * Assign fallback accelerators when a menu leaves them unspecified.
 * @param items - menu rows in source order.
 * @returns rows paired with stable source indexes and accelerators.
 */
function assignAccelerators(items: MenuItem[]) {
  let automaticIndex = 0;
  return items.map((item, index) => {
    let accelerator = item.accelerator;
    if (item.identifier !== null && accelerator === 0) {
      accelerator = AUTO_ACCELERATORS.charCodeAt(automaticIndex);
      automaticIndex += 1;
    }
    return { item, index, accelerator };
  });
}

/**
 * Move menu focus with wraparound.
 * @param indexes - selectable source indexes.
 * @param current - current source index.
 * @param delta - movement direction.
 * @returns the next source index.
 */
function moveMenuFocus(indexes: number[], current: number, delta: number): number {
  if (indexes.length === 0) return -1;
  const position = indexes.indexOf(current);
  return indexes[wrapIndex(position + delta, indexes.length)];
}

/**
 * Wrap an index into an array length.
 * @param value - unbounded index.
 * @param length - array length.
 * @returns a valid index, or zero for an empty array.
 */
function wrapIndex(value: number, length: number): number {
  return length === 0 ? 0 : (value % length + length) % length;
}

/**
 * Convert a menu count buffer to NetHack's count convention.
 * @param value - decimal count text.
 * @returns a positive count or -1 for all.
 */
function parsedCount(value: string): number {
  if (value === "") return -1;
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) && count > 0 ? count : -1;
}

/**
 * Return the browser window through a named helper for effect cleanup.
 * @returns the active Window object.
 */
function windowThis(): Window {
  return window;
}

export default GameScreen;
