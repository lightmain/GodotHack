import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
} from "react";
import {
  getSnapshot,
  type GameSnapshot,
  type MapCell,
  type TextLine,
} from "../../game-state";
import {
  buildMapRuns,
  mapFollowOffset,
  mapPositionFromPoint,
} from "../../map-rendering";
import {
  normalizePlayerNameInput,
  sendPosition,
  submitLine,
} from "../../nethack-bridge";
import type { InterfaceSettingsV1 } from "../../settings/profile";
import { colorClass, textAttributeClass } from "../../text-styling";
import { PermanentInventoryPanel } from "../PermanentInventoryPanel";
import { StatusArea } from "./StatusArea";

interface GameTerminalProps {
  clipCenter: GameSnapshot["clipCenter"];
  cursor: GameSnapshot["cursor"];
  followPlayer: boolean;
  historyLines: InterfaceSettingsV1["messageHistoryLines"];
  inert: boolean;
  inputRequest: GameSnapshot["inputRequest"];
  layoutKey: string;
  map: MapCell[][];
  messages: TextLine[];
  onInventoryCollapsedChange(collapsed: boolean): void;
  permanentInventory: GameSnapshot["permanentInventory"];
  permanentInventoryCollapsed: boolean;
  permanentInventoryEnabled: boolean;
  permanentInventoryPosition: InterfaceSettingsV1["permanentInventoryPosition"];
  status: GameSnapshot["status"];
}

/** Render the active terminal while keeping browser overlays outside its inert tree. */
export function GameTerminal({
  clipCenter,
  cursor,
  followPlayer,
  historyLines,
  inert,
  inputRequest,
  layoutKey,
  map,
  messages,
  onInventoryCollapsedChange,
  permanentInventory,
  permanentInventoryCollapsed,
  permanentInventoryEnabled,
  permanentInventoryPosition,
  status,
}: GameTerminalProps) {
  return (
    <section
      aria-label="NetHack terminal"
      className="nh-terminal"
      inert={inert}
    >
      <MessageArea historyLines={historyLines} messages={messages} />
      <div className={`nh-playfield nh-playfield-${permanentInventoryPosition}`}>
        <div className="nh-playfield-main">
          <MapGrid
            clipCenter={clipCenter}
            cursor={cursor}
            followPlayer={followPlayer}
            layoutKey={layoutKey}
            map={map}
          />
          <StatusArea status={status} />
          <InputArea request={inputRequest} />
        </div>
        {permanentInventoryEnabled && permanentInventory && (
          <PermanentInventoryPanel
            collapsed={permanentInventoryCollapsed}
            inventory={permanentInventory}
            onCollapsedChange={onInventoryCollapsedChange}
            position={permanentInventoryPosition}
          />
        )}
      </div>
    </section>
  );
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
