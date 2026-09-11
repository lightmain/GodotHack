import {
  MENU_BEHAVE_PERMINV,
  NHW_MAP,
  NHW_MENU,
  NHW_MESSAGE,
  PICK_NONE,
  appendWindowText,
  clearModal,
  flushDisplay,
  getWindow,
  setCommandInput,
  setInputRequest,
  setInventoryWindow,
  setRuntimeSettingsSnapshot,
  setRuntimeSettingsStatus,
  showExtendedCommands,
  showHistory,
  showMenu,
  showText,
  type MenuItem,
} from "../game-state";
import type { NetHackSettingsV1 } from "../settings/profile";
import {
  decodeRuntimeSettings,
  encodeRuntimeSettings,
  runtimeSettingsFromProfile,
  type RuntimeNetHackSettings,
} from "../settings/runtime-settings-protocol";
import type { EmscriptenModule } from "./emscripten-module";
import { readExtendedCommands } from "./shim-decoders";

interface MenuSelection {
  itemIndex: number;
  count: number;
}

type PendingAction =
  | {
    kind: "key";
    resolve: (value: number) => void;
    positionPointers: { x: number; y: number; modifier: number } | null;
    module: EmscriptenModule;
    commandInput: boolean;
  }
  | {
    kind: "yn";
    resolve: (value: number) => void;
    choices: string | null;
    defaultCode: number;
  }
  | {
    kind: "message";
    resolve: (value: number) => void;
    acceptedCode: number;
  }
  | {
    kind: "line";
    resolve: () => void;
    purpose: "name" | "getlin";
    bufferPtr: number;
    module: EmscriptenModule;
  }
  | {
    kind: "menu";
    resolve: (value: number) => void;
    windowId: number;
    how: number;
    menuListPtr: number;
    module: EmscriptenModule;
  }
  | {
    kind: "display";
    resolve: () => void;
  }
  | { kind: "extcmd"; resolve: (value: number) => void };

const MENU_ITEM_SIZE = 16;
const MENU_ITEM_COUNT_OFFSET = 8;
const MENU_ITEM_FLAGS_OFFSET = 12;
const GETLIN_BUFFER_SIZE = 256;
const PLAYER_NAME_BUFFER_SIZE = 32;
const KEY_QUEUE_LIMIT = 2;
const SAVE_COMMAND = "S".charCodeAt(0);
const SAVE_CONFIRM_QUERY = "Really save?";
const YES_RESPONSE = "y".charCodeAt(0);

let pendingAction: PendingAction | null = null;
const queuedKeys: number[] = [];
let typeaheadEnabled = false;
let saveExitAutomation: "confirm" | "display" | null = null;
let knownSaveNames: string[] = [];
let pendingRuntimeSettings: RuntimeNetHackSettings | null = null;

/** Queue one complete dynamic settings update for the next safe boundary. */
export function queueRuntimeSettings(settings: NetHackSettingsV1): void {
  pendingRuntimeSettings = runtimeSettingsFromProfile(settings);
  setRuntimeSettingsStatus("pending");
}

/** Supply names which askname may resolve to an existing save. */
export function setKnownSaveNames(names: string[]): void {
  knownSaveNames = [...new Set(names)];
}

/** Apply exactly the same cleanup used when a player name is submitted. */
export function normalizePlayerNameInput(value: string): string {
  return truncateUtf8(value.trim(), PLAYER_NAME_BUFFER_SIZE - 1);
}

/** Resolve the active keyboard-facing callback with one NetHack byte. */
export function sendKey(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > 0xff) return;
  const pending = pendingAction;
  if (!pending) {
    if (typeaheadEnabled && queuedKeys.length < KEY_QUEUE_LIMIT) {
      queuedKeys.push(value);
    }
    return;
  }

  if (pending.kind === "key") {
    pendingAction = null;
    typeaheadEnabled = true;
    setCommandInput(false);
    setInputRequest(null);
    pending.resolve(value);
    return;
  }
  if (pending.kind === "yn") {
    const response = normalizeYnResponse(
      value,
      pending.choices,
      pending.defaultCode,
    );
    if (response === null) return;
    pendingAction = null;
    setInputRequest(null);
    pending.resolve(response);
    return;
  }
  if (pending.kind === "message") {
    const response = value === 27
      ? 27
      : value === pending.acceptedCode
        ? pending.acceptedCode
        : 0;
    pendingAction = null;
    setInputRequest(null);
    pending.resolve(response);
    return;
  }
  if (pending.kind === "display") {
    pendingAction = null;
    clearModal();
    setInputRequest(null);
    pending.resolve();
  }
}

/** Send the native save command from a top-level command prompt. */
export function requestSaveAndExit(): void {
  if (pendingAction?.kind !== "key" || !pendingAction.commandInput) return;
  saveExitAutomation = "confirm";
  sendKey(SAVE_COMMAND);
}

/** Resolve nh_poskey with a map position and mouse button modifier. */
export function sendPosition(x: number, y: number, modifier: 1 | 2): void {
  const pending = pendingAction;
  if (pending?.kind !== "key" || !pending.positionPointers) return;
  pending.module.setValue(pending.positionPointers.x, x, "i16");
  pending.module.setValue(pending.positionPointers.y, y, "i16");
  pending.module.setValue(pending.positionPointers.modifier, modifier, "i32");
  pendingAction = null;
  typeaheadEnabled = true;
  setCommandInput(false);
  setInputRequest(null);
  pending.resolve(0);
}

/** Submit a name or getlin response. */
export function submitLine(value: string | null): void {
  const pending = pendingAction;
  if (pending?.kind !== "line") return;

  if (pending.purpose === "name") {
    if (value === null || value.trim() === "") return;
    const name = normalizePlayerNameInput(value);
    const globals = globalThis.nethackGlobal?.globals;
    if (globals?.svp) globals.svp.plname = name;
  } else {
    if (value === null) {
      pending.module.setValue(pending.bufferPtr, 27, "i8");
      pending.module.setValue(pending.bufferPtr + 1, 0, "i8");
    } else {
      pending.module.stringToUTF8(value, pending.bufferPtr, GETLIN_BUFFER_SIZE);
    }
  }

  pendingAction = null;
  setInputRequest(null);
  pending.resolve();
}

/** Submit selected rows from an active NetHack menu. */
export function submitMenuSelection(
  selected: MenuSelection[] | null,
): void {
  const pending = pendingAction;
  if (pending?.kind !== "menu") return;
  const window = getWindow(pending.windowId);
  const module = pending.module;
  pendingAction = null;
  clearModal();

  if (selected === null) {
    pending.resolve(-1);
    return;
  }

  const valid = selected
    .filter((selection) => selection.count !== 0)
    .map((selection) => ({
      selection,
      item: window?.menuItems[selection.itemIndex],
    }))
    .filter(
      (entry): entry is { selection: MenuSelection; item: MenuItem } =>
        entry.item?.identifier !== null && entry.item !== undefined,
    );
  const limited = pending.how === 1 ? valid.slice(0, 1) : valid;

  if (limited.length === 0) {
    pending.resolve(0);
    return;
  }

  const resultPtr = module._malloc(limited.length * MENU_ITEM_SIZE);
  limited.forEach(({ selection, item }, index) => {
    const itemPtr = resultPtr + index * MENU_ITEM_SIZE;
    module.setValue(itemPtr, item.identifier as number, "i32");
    module.setValue(itemPtr + 4, 0, "i32");
    module.setValue(itemPtr + MENU_ITEM_COUNT_OFFSET, selection.count, "i32");
    module.setValue(itemPtr + MENU_ITEM_FLAGS_OFFSET, 0, "i32");
  });
  module.setValue(pending.menuListPtr, resultPtr, "*");
  pending.resolve(limited.length);
}

/** Submit an extended-command source index, or cancel with null. */
export function submitExtendedCommand(sourceIndex: number | null): void {
  const pending = pendingAction;
  if (pending?.kind !== "extcmd") return;
  pendingAction = null;
  clearModal();
  pending.resolve(sourceIndex ?? -1);
}

/** Dismiss a blocking text/history display or a PICK_NONE menu. */
export function dismissDisplay(): void {
  const pending = pendingAction;
  if (!pending) return;
  if (pending.kind === "display") {
    pendingAction = null;
    clearModal();
    setInputRequest(null);
    pending.resolve();
  } else if (pending.kind === "menu" && pending.how === PICK_NONE) {
    pendingAction = null;
    clearModal();
    pending.resolve(0);
  }
}

/** Report whether any shim callback is waiting for user input. */
export function isWaitingForInput(): boolean {
  return pendingAction !== null;
}

/** Reset the singleton controller for a fresh module session. */
export function resetInputController(): void {
  pendingAction = null;
  pendingRuntimeSettings = null;
  queuedKeys.length = 0;
  typeaheadEnabled = false;
  saveExitAutomation = null;
  knownSaveNames = [];
}

/** Publish the core snapshot and return one queued, versioned update. */
export function synchronizeRuntimeSettings(snapshotPayload: number): number {
  const current = decodeRuntimeSettings(snapshotPayload);
  if (current.pending) {
    throw new Error("Core runtime settings snapshot is marked pending");
  }
  const pending = pendingRuntimeSettings;
  setRuntimeSettingsSnapshot(
    current.settings,
    pending ? "pending" : "idle",
  );
  if (!pending) return 0;
  pendingRuntimeSettings = null;
  return encodeRuntimeSettings(pending, true);
}

/** Process the core's post-application status and authoritative snapshot. */
export function acceptRuntimeSettingsResult(
  success: number,
  snapshotPayload: number,
): void {
  const current = decodeRuntimeSettings(snapshotPayload);
  if (current.pending) {
    throw new Error("Core runtime settings result is marked pending");
  }
  setRuntimeSettingsSnapshot(
    current.settings,
    pendingRuntimeSettings ? "pending" : success === 1 ? "applied" : "idle",
  );
  if (success !== 1) {
    throw new Error("Core rejected a validated runtime settings update");
  }
}

/** Display a window and optionally wait for user acknowledgement. */
export function displayWindow(
  winid: number,
  blocking: boolean,
): Promise<void> | undefined {
  flushDisplay();
  const window = getWindow(winid);
  if (
    saveExitAutomation === "display"
    && blocking
    && window?.type === NHW_MESSAGE
  ) {
    saveExitAutomation = null;
    return undefined;
  }
  const needsAcknowledgement = blocking
    || (window?.type !== NHW_MAP && window?.type !== NHW_MESSAGE);
  if (!needsAcknowledgement) return undefined;
  if (window?.type === NHW_MENU && window.menuItems.length > 0) {
    showMenu(winid, PICK_NONE);
  } else if (window?.type !== NHW_MAP && window?.type !== NHW_MESSAGE) {
    showText("", window?.lines ?? []);
  } else {
    setInputRequest({ kind: "message", message: "--More--", acceptedCode: 0 });
  }
  return waitForDisplay();
}

/** Install a blocking display acknowledgement. */
export function waitForDisplay(): Promise<void> {
  return new Promise<void>((resolve) => {
    setPending({ kind: "display", resolve });
  });
}

/** Display a built menu and wait for its selection result. */
export function selectMenu(
  module: EmscriptenModule,
  winid: number,
  how: number,
  menuListPtr: number,
): Promise<number> | number {
  if (menuListPtr !== 0) module.setValue(menuListPtr, 0, "*");
  const window = getWindow(winid);
  if (window && (window.menuBehavior & MENU_BEHAVE_PERMINV) !== 0) {
    if (how !== PICK_NONE) {
      throw new Error("Permanent inventory menu requires PICK_NONE");
    }
    setInventoryWindow(winid);
    return 0;
  }

  showMenu(winid, how);
  return new Promise<number>((resolve) => {
    setPending({
      kind: "menu",
      resolve,
      windowId: winid,
      how,
      menuListPtr,
      module,
    });
  });
}

/** Implement the single-line message-menu contract. */
export function messageMenu(
  acceptedCode: number,
  how: number,
  message: string,
): Promise<number> | number {
  appendWindowText(-1, 0, message);
  if (how === PICK_NONE) return 0;
  setInputRequest({ kind: "message", message, acceptedCode });
  return new Promise<number>((resolve) => {
    setPending({ kind: "message", resolve, acceptedCode });
  });
}

/** Wait for keyboard or mouse input requested by the core. */
export function waitForKey(
  module: EmscriptenModule,
  positionPointers: { x: number; y: number; modifier: number } | null,
  commandInput: boolean,
): Promise<number> {
  if (commandInput && saveExitAutomation !== null) {
    saveExitAutomation = null;
  }
  setCommandInput(commandInput);
  const queued = queuedKeys.shift();
  if (queued !== undefined) {
    setCommandInput(false);
    return Promise.resolve(queued);
  }
  setInputRequest({ kind: positionPointers ? "position" : "key" });
  return new Promise<number>((resolve) => {
    setPending({
      kind: "key",
      resolve,
      positionPointers,
      module,
      commandInput,
    });
  });
}

/** Wait for and normalize a yn_function response. */
export function waitForYn(
  query: string | null,
  choices: string | null,
  defaultCode: number,
): Promise<number> {
  const normalizedQuery = query ?? "";
  if (saveExitAutomation === "confirm") {
    if (normalizedQuery === SAVE_CONFIRM_QUERY && choices === "yn") {
      saveExitAutomation = "display";
      return Promise.resolve(YES_RESPONSE);
    }
    saveExitAutomation = null;
  } else if (saveExitAutomation === "display") {
    saveExitAutomation = null;
  }
  setInputRequest({
    kind: "yn",
    query: normalizedQuery,
    choices,
    defaultCode,
  });
  return new Promise<number>((resolve) => {
    setPending({ kind: "yn", resolve, choices, defaultCode });
  });
}

/** Wait for player-name or getlin text entry. */
export function waitForLine(
  module: EmscriptenModule,
  purpose: "name" | "getlin",
  query: string,
  bufferPtr: number,
): Promise<void> {
  setInputRequest(
    purpose === "name" && knownSaveNames.length > 0
      ? {
        kind: "line",
        purpose,
        query,
        existingSaveNames: [...knownSaveNames],
      }
      : { kind: "line", purpose, query },
  );
  return new Promise<void>((resolve) => {
    setPending({ kind: "line", resolve, purpose, bufferPtr, module });
  });
}

/** Show message history and wait until the player dismisses it. */
export function displayHistory(): Promise<number> {
  showHistory();
  return new Promise<number>((resolve) => {
    setPending({ kind: "display", resolve: () => resolve(0) });
  });
}

/** Parse extcmdlist and wait for a command selection. */
export function waitForExtendedCommand(
  module: EmscriptenModule,
): Promise<number> | number {
  const commands = readExtendedCommands(module);
  if (commands.length === 0) return -1;
  showExtendedCommands(commands);
  return new Promise<number>((resolve) => {
    setPending({ kind: "extcmd", resolve });
  });
}

function normalizeYnResponse(
  value: number,
  choices: string | null,
  defaultCode: number,
): number | null {
  if (!Number.isInteger(value) || value < 0 || value > 0x7f) return null;
  if (choices === null) return value;
  if (value === 32 || value === 10 || value === 13) {
    return defaultCode > 0 ? defaultCode : null;
  }
  if (value === 27) {
    if (choices.includes("q")) return "q".charCodeAt(0);
    if (choices.includes("n")) return "n".charCodeAt(0);
    return defaultCode > 0 ? defaultCode : null;
  }
  if (
    choices.includes("#")
    && (value === "#".charCodeAt(0)
      || (value >= "0".charCodeAt(0) && value <= "9".charCodeAt(0)))
  ) {
    return null;
  }
  const character = String.fromCharCode(value);
  if (choices.includes(character)) return value;
  const lower = character.toLowerCase();
  return choices.includes(lower) ? lower.charCodeAt(0) : null;
}

function setPending(action: PendingAction): void {
  if (pendingAction !== null) {
    throw new Error(
      `Cannot start ${action.kind}; ${pendingAction.kind} is still pending`,
    );
  }
  if (action.kind !== "key") {
    queuedKeys.length = 0;
    typeaheadEnabled = false;
  }
  pendingAction = action;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = "";
  let used = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).length;
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}
