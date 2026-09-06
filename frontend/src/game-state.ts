import type { RuntimeNetHackSettings } from "./settings/runtime-settings-protocol";

/** NetHack map width, including the unused column zero. */
export const COLNO = 80;
/** NetHack map height. */
export const ROWNO = 21;

export const NHW_MESSAGE = 1;
export const NHW_STATUS = 2;
export const NHW_MAP = 3;
export const NHW_MENU = 4;
export const NHW_TEXT = 5;
export const NHW_PERMINVENT = 6;

export const PICK_NONE = 0;
export const PICK_ONE = 1;
export const PICK_ANY = 2;

export const MENU_BEHAVE_STANDARD = 0;
export const MENU_BEHAVE_PERMINV = 1;

export const ATR_NONE = 0;
export const ATR_BOLD = 1;
export const ATR_DIM = 2;
export const ATR_ITALIC = 3;
export const ATR_ULINE = 4;
export const ATR_BLINK = 5;
export const ATR_INVERSE = 7;
export const ATR_URGENT = 16;
export const ATR_NOHISTORY = 32;

export const BL_RESET = -2;
export const BL_FLUSH = -1;
export const BL_GOLD = 10;
export const BL_CONDITION = 22;

/** A styled line sent through putstr or raw_print. */
export interface TextLine {
  text: string;
  attribute: number;
}

/** Decoded fields from one glyph_info structure. */
export interface GlyphInfo {
  glyph: number;
  ttyChar: number;
  frameColor: number;
  glyphFlags: number;
  color: number;
  symbolIndex: number;
  customColor: number;
  color256: number;
  tileIndex: number;
}

/** Foreground and optional background glyphs at a map coordinate. */
export interface MapCell {
  foreground: GlyphInfo | null;
  background: GlyphInfo | null;
}

/** One menu row with the identifier decoded by winshim's "i" format. */
export interface MenuItem {
  glyph: GlyphInfo | null;
  identifier: number | null;
  accelerator: number;
  groupAccelerator: number;
  attribute: number;
  color: number;
  text: string;
  itemFlags: number;
}

/** Mutable content associated with a NetHack window ID. */
export interface WindowState {
  id: number;
  type: number;
  lines: TextLine[];
  menuItems: MenuItem[];
  menuPrompt: string;
  menuBehavior: number;
}

/** One formatted status field ready for rendering. */
export interface StatusValue {
  text: string;
  change: number;
  percent: number;
  color: number;
  attributes: number;
  conditionMask?: number;
  conditionColors: number[];
}

/** One parsed command from NetHack's extcmdlist. */
export interface ExtendedCommand {
  sourceIndex: number;
  name: string;
  description: string;
}

/** Modal content which pauses or overlays the game. */
export type GameModal =
  | { kind: "menu"; windowId: number; how: number }
  | { kind: "text"; title: string; lines: TextLine[] }
  | { kind: "history"; lines: TextLine[] }
  | { kind: "extcmd"; commands: ExtendedCommand[] };

/** Input request currently blocking the NetHack core. */
export type InputRequest =
  | { kind: "key" }
  | { kind: "position" }
  | { kind: "yn"; query: string; choices: string | null; defaultCode: number }
  | {
    kind: "line";
    purpose: "name" | "getlin";
    query: string;
    existingSaveNames?: string[];
  }
  | { kind: "message"; message: string; acceptedCode: number };

/** Immutable top-level snapshot consumed by React. */
export interface GameSnapshot {
  revision: number;
  phase: "idle" | "loading" | "running" | "exited" | "error";
  error: string | null;
  exitReason: string;
  messages: TextLine[];
  messageHistory: TextLine[];
  map: MapCell[][];
  cursor: { x: number; y: number; visible: boolean };
  status: Record<number, StatusValue>;
  modal: GameModal | null;
  inputRequest: InputRequest | null;
  commandInput: boolean;
  runtimeSettings: RuntimeNetHackSettings | null;
  runtimeSettingsStatus: "idle" | "pending" | "applied";
  numberPad: boolean;
  inventoryWindowId: number | null;
  bellCount: number;
  clipCenter: { x: number; y: number } | null;
  lastPreference: string | null;
}

type Listener = () => void;

const windows = new Map<number, WindowState>();
const listeners = new Set<Listener>();
let nextWindowId = 1;
let pendingStatus: Record<number, StatusValue> = {};
let pendingMapRows = new Map<number, MapCell[]>();
let restoredMessageHistory: TextLine[] | null = null;
let currentMessageHistory: TextLine[] | null = null;
let snapshot = createInitialSnapshot();

/**
 * Create a blank 80 by 21 map.
 * @returns a fresh map whose cells can be independently updated.
 */
function createBlankMap(): MapCell[][] {
  return Array.from({ length: ROWNO }, () =>
    Array.from({ length: COLNO }, () => ({
      foreground: null,
      background: null,
    })),
  );
}

/**
 * Create the default frontend game snapshot.
 * @returns a fresh initial state value.
 */
function createInitialSnapshot(): GameSnapshot {
  return {
    revision: 0,
    phase: "idle",
    error: null,
    exitReason: "",
    messages: [],
    messageHistory: [],
    map: createBlankMap(),
    cursor: { x: 1, y: 0, visible: false },
    status: {},
    modal: null,
    inputRequest: null,
    commandInput: false,
    runtimeSettings: null,
    runtimeSettingsStatus: "idle",
    numberPad: false,
    inventoryWindowId: null,
    bellCount: 0,
    clipCenter: null,
    lastPreference: null,
  };
}

/**
 * Publish a new snapshot identity and notify all subscribers.
 * @param patch - top-level fields to replace before notification.
 */
function publish(patch: Partial<GameSnapshot> = {}): void {
  snapshot = {
    ...snapshot,
    ...patch,
    revision: snapshot.revision + 1,
  };
  for (const listener of listeners) listener();
}

/**
 * Read the current immutable top-level game snapshot.
 * @returns the current snapshot.
 */
export function getSnapshot(): GameSnapshot {
  return snapshot;
}

/**
 * Subscribe to published game-state changes.
 * @param listener - callback invoked after a snapshot is published.
 * @returns an unsubscribe function.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Reset all game and window state while preserving active subscribers.
 */
export function resetGameState(): void {
  windows.clear();
  nextWindowId = 1;
  pendingStatus = {};
  pendingMapRows = new Map();
  restoredMessageHistory = null;
  currentMessageHistory = null;
  snapshot = createInitialSnapshot();
  for (const listener of listeners) listener();
}

/**
 * Set the WASM runtime lifecycle phase.
 * @param phase - new runtime phase.
 */
export function setRuntimePhase(phase: GameSnapshot["phase"]): void {
  publish({ phase, error: phase === "error" ? snapshot.error : null });
}

/**
 * Record a fatal startup or runtime error.
 * @param message - user-visible error text.
 */
export function setRuntimeError(message: string): void {
  publish({ phase: "error", error: message });
}

/**
 * Record that NetHack has exited.
 * @param reason - exit reason supplied by the core.
 */
export function setExitReason(reason: string): void {
  publish({ phase: "exited", exitReason: reason });
}

/**
 * Allocate a unique window ID for a declared NetHack window type.
 * @param type - one of the NHW_* constants.
 * @returns the allocated non-WIN_ERR window ID.
 */
export function createWindow(type: number): number {
  const id = nextWindowId;
  nextWindowId += 1;
  windows.set(id, {
    id,
    type,
    lines: [],
    menuItems: [],
    menuPrompt: "",
    menuBehavior: MENU_BEHAVE_STANDARD,
  });
  return id;
}

/**
 * Look up mutable state for a NetHack window.
 * @param winid - window ID returned by createWindow.
 * @returns the window or undefined when it no longer exists.
 */
export function getWindow(winid: number): WindowState | undefined {
  return windows.get(winid);
}

/**
 * Clear the content owned by one NetHack window.
 * @param winid - target window ID.
 */
export function clearWindow(winid: number): void {
  const window = windows.get(winid);
  if (!window) return;
  window.lines = [];
  window.menuItems = [];
  window.menuPrompt = "";
  if (window.type === NHW_MAP) {
    pendingMapRows.clear();
    publish({ map: createBlankMap() });
  } else if (window.type === NHW_MESSAGE) {
    publish({ messages: [] });
  }
}

/**
 * Destroy a NetHack window and dismiss UI which references it.
 * @param winid - target window ID.
 */
export function destroyWindow(winid: number): void {
  windows.delete(winid);
  const modal = snapshot.modal?.kind === "menu"
    && snapshot.modal.windowId === winid
    ? null
    : snapshot.modal;
  const inventoryWindowId = snapshot.inventoryWindowId === winid
    ? null
    : snapshot.inventoryWindowId;
  if (
    modal !== snapshot.modal
    || inventoryWindowId !== snapshot.inventoryWindowId
  ) {
    publish({ modal, inventoryWindowId });
  }
}

/**
 * Append text to a message, text, or menu window.
 * @param winid - destination window ID.
 * @param attribute - ATR_* text flags.
 * @param text - decoded UTF-8 text.
 */
export function appendWindowText(
  winid: number,
  attribute: number,
  text: string,
): void {
  const window = windows.get(winid);
  const line = { text, attribute };
  if (window?.type === NHW_MESSAGE) {
    const messages = [...snapshot.messages, line].slice(-200);
    const messageHistory = (attribute & ATR_NOHISTORY) !== 0
      ? snapshot.messageHistory
      : [...snapshot.messageHistory, line].slice(-500);
    publish({ messages, messageHistory });
    return;
  }
  if (window) {
    window.lines.push(line);
    return;
  }
  publish({
    messages: [...snapshot.messages, line].slice(-200),
    messageHistory: [...snapshot.messageHistory, line].slice(-500),
  });
}

/**
 * Store a message supplied through putmsghistory.
 * @param text - history text, or null when restoration is complete.
 * @param restoring - whether the text comes from a restored save.
 */
export function putMessageHistory(
  text: string | null,
  restoring: boolean,
): void {
  if (!restoring) {
    if (text === null) return;
    const line = { text, attribute: ATR_NONE };
    publish({
      messageHistory: [...snapshot.messageHistory, line].slice(-500),
    });
    return;
  }

  if (text !== null) {
    if (restoredMessageHistory === null) {
      restoredMessageHistory = [];
      currentMessageHistory = [...snapshot.messageHistory];
    }
    restoredMessageHistory.push({ text, attribute: ATR_NONE });
    return;
  }

  if (restoredMessageHistory !== null) {
    publish({
      messageHistory: [
        ...restoredMessageHistory,
        ...(currentMessageHistory ?? []),
      ].slice(-500),
    });
  }
  restoredMessageHistory = null;
  currentMessageHistory = null;
}

/**
 * Update one valid map coordinate without publishing a render yet.
 * @param x - map column in the valid range 1..79.
 * @param y - map row in the valid range 0..20.
 * @param foreground - primary glyph.
 * @param background - optional background glyph.
 */
export function setMapCell(
  x: number,
  y: number,
  foreground: GlyphInfo,
  background: GlyphInfo | null,
): void {
  if (x < 1 || x >= COLNO || y < 0 || y >= ROWNO) return;
  const currentRow = pendingMapRows.get(y) ?? snapshot.map[y];
  const current = currentRow[x];
  if (
    glyphsEqual(current.foreground, foreground)
    && glyphsEqual(current.background, background)
  ) {
    return;
  }
  const row = pendingMapRows.get(y) ?? snapshot.map[y].slice();
  row[x] = { foreground, background };
  pendingMapRows.set(y, row);
}

/**
 * Publish buffered map mutations.
 */
export function flushDisplay(): void {
  if (pendingMapRows.size === 0) return;
  const map = snapshot.map.slice();
  for (const [y, row] of pendingMapRows) map[y] = row;
  pendingMapRows.clear();
  publish({ map });
}

/**
 * Set the visible map cursor.
 * @param _winid - map window ID supplied by the core.
 * @param x - map column.
 * @param y - map row.
 */
export function setCursor(_winid: number, x: number, y: number): void {
  if (
    snapshot.cursor.visible
    && snapshot.cursor.x === x
    && snapshot.cursor.y === y
  ) {
    return;
  }
  publish({ cursor: { x, y, visible: true } });
}

/**
 * Compare nullable glyphs by every field exposed to the frontend.
 * @param left - current glyph.
 * @param right - incoming glyph.
 * @returns whether both glyph values are equivalent.
 */
function glyphsEqual(
  left: GlyphInfo | null,
  right: GlyphInfo | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.glyph === right.glyph
    && left.ttyChar === right.ttyChar
    && left.frameColor === right.frameColor
    && left.glyphFlags === right.glyphFlags
    && left.color === right.color
    && left.symbolIndex === right.symbolIndex
    && left.customColor === right.customColor
    && left.color256 === right.color256
    && left.tileIndex === right.tileIndex;
}

/**
 * Begin rebuilding one menu.
 * @param winid - menu window ID.
 * @param behavior - MENU_BEHAVE_* flags.
 */
export function beginMenu(winid: number, behavior: number): void {
  const window = windows.get(winid);
  if (!window) return;
  window.menuItems = [];
  window.menuPrompt = "";
  window.menuBehavior = behavior;
}

/**
 * Append one fully decoded row to a menu.
 * @param winid - menu window ID.
 * @param item - copied menu row.
 */
export function addMenuItem(winid: number, item: MenuItem): void {
  windows.get(winid)?.menuItems.push(item);
}

/**
 * Finish building a menu and store its prompt.
 * @param winid - menu window ID.
 * @param prompt - menu prompt, with null represented as an empty string.
 */
export function endMenu(winid: number, prompt: string): void {
  const window = windows.get(winid);
  if (window) window.menuPrompt = prompt;
}

/**
 * Present a menu as the active modal.
 * @param winid - menu window ID.
 * @param how - PICK_NONE, PICK_ONE, or PICK_ANY.
 */
export function showMenu(winid: number, how: number): void {
  publish({ modal: { kind: "menu", windowId: winid, how } });
}

/**
 * Present text lines as the active modal.
 * @param title - modal title.
 * @param lines - text content.
 */
export function showText(title: string, lines: TextLine[]): void {
  publish({ modal: { kind: "text", title, lines: [...lines] } });
}

/**
 * Present the complete message history as the active modal.
 */
export function showHistory(): void {
  publish({ modal: { kind: "history", lines: [...snapshot.messageHistory] } });
}

/**
 * Present parsed extended commands as the active modal.
 * @param commands - commands available for selection.
 */
export function showExtendedCommands(commands: ExtendedCommand[]): void {
  publish({ modal: { kind: "extcmd", commands } });
}

/**
 * Dismiss the active modal.
 */
export function clearModal(): void {
  if (snapshot.modal !== null) publish({ modal: null });
}

/**
 * Set or clear the active core input request.
 * @param request - pending request, or null after it resolves.
 */
export function setInputRequest(request: InputRequest | null): void {
  publish({ inputRequest: request });
}

/** Record whether the core is waiting for a top-level command key. */
export function setCommandInput(commandInput: boolean): void {
  if (snapshot.commandInput !== commandInput) publish({ commandInput });
}

/** Replace the active dynamic settings snapshot reported by the core. */
export function setRuntimeSettingsSnapshot(
  runtimeSettings: RuntimeNetHackSettings,
  runtimeSettingsStatus: GameSnapshot["runtimeSettingsStatus"] =
    snapshot.runtimeSettingsStatus,
): void {
  publish({ runtimeSettings, runtimeSettingsStatus });
}

/** Record the lifecycle of one queued dynamic settings update. */
export function setRuntimeSettingsStatus(
  runtimeSettingsStatus: GameSnapshot["runtimeSettingsStatus"],
): void {
  if (snapshot.runtimeSettingsStatus !== runtimeSettingsStatus) {
    publish({ runtimeSettingsStatus });
  }
}

/**
 * Store a status field in the pending atomic update buffer.
 * @param field - BL_* field index.
 * @param value - decoded field display data.
 */
export function setStatusValue(field: number, value: StatusValue): void {
  pendingStatus = { ...pendingStatus, [field]: value };
}

/**
 * Publish all status updates collected in the current bot cycle.
 */
export function flushStatus(): void {
  publish({ status: { ...snapshot.status, ...pendingStatus } });
  pendingStatus = {};
}

/**
 * Clear committed and pending status values.
 */
export function resetStatus(): void {
  pendingStatus = {};
  publish({ status: {} });
}

/**
 * Store NetHack's active number-pad mode.
 * @param enabled - whether number-pad movement is enabled.
 */
export function setNumberPad(enabled: boolean): void {
  publish({ numberPad: enabled });
}

/**
 * Mark the menu window which contains persistent inventory data.
 * @param winid - persistent inventory window ID.
 */
export function setInventoryWindow(winid: number): void {
  publish({ inventoryWindowId: winid });
}

/**
 * Record the most recent clip-around center.
 * @param x - map column.
 * @param y - map row.
 */
export function setClipCenter(x: number, y: number): void {
  publish({ clipCenter: { x, y } });
}

/**
 * Record a preference name supplied by preference_update.
 * @param preference - decoded preference name.
 */
export function setLastPreference(preference: string): void {
  publish({ lastPreference: preference });
}

/**
 * Increment the observable bell counter.
 */
export function ringBell(): void {
  publish({ bellCount: snapshot.bellCount + 1 });
}
