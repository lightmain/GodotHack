/**
 * Strict TypeScript implementation of the NetHack 5.0 shim_graphics callback.
 * Contracts are derived from win/shim/winshim.c and doc/window.txt.
 */

import {
  ATR_BOLD,
  BL_CONDITION,
  BL_FLUSH,
  BL_GOLD,
  BL_RESET,
  MENU_BEHAVE_PERMINV,
  NHW_MAP,
  NHW_MENU,
  NHW_MESSAGE,
  PICK_NONE,
  addMenuItem,
  appendWindowText,
  beginMenu,
  clearModal,
  clearWindow,
  createWindow,
  destroyWindow,
  endMenu,
  flushDisplay,
  flushStatus,
  getWindow,
  resetGameState,
  resetStatus,
  putMessageHistory,
  ringBell,
  setClipCenter,
  setCommandInput,
  setCursor,
  setExitReason,
  setInputRequest,
  setInventoryWindow,
  setLastPreference,
  setMapCell,
  setNumberPad,
  setRuntimeError,
  setRuntimePhase,
  setRuntimeSettingsSnapshot,
  setRuntimeSettingsStatus,
  setStatusValue,
  showExtendedCommands,
  showHistory,
  showMenu,
  showText,
  type ExtendedCommand,
  type GlyphInfo,
  type MenuItem,
  type TextLine,
} from "./game-state";
import { readDlbEntry } from "./dlb";
import type {
  SaveIdentity,
  SaveValidation,
  StorageModule,
} from "./storage/storage-service";
import type { NetHackSettingsV1 } from "./settings/profile";
import {
  decodeRuntimeSettings,
  encodeRuntimeSettings,
  runtimeSettingsFromProfile,
  type RuntimeNetHackSettings,
} from "./settings/runtime-settings-protocol";

/** Emscripten filesystem surface used by DLB access and save persistence. */
export interface EmscriptenFileSystem {
  analyzePath(path: string): { exists: boolean };
  mkdir(path: string): unknown;
  mount(type: unknown, options: Record<string, unknown>, path: string): unknown;
  readFile(
    path: string,
    options?: { encoding: "utf8" },
  ): string | Uint8Array;
  syncfs(
    populate: boolean,
    callback: (error: unknown | null) => void,
  ): void;
}

/** Emscripten module APIs required by the shim bridge. */
export interface EmscriptenModule {
  ccall(
    name: string,
    returnType: string | null,
    argumentTypes: string[],
    arguments_: unknown[],
    options?: { async: boolean },
  ): unknown;
  getValue(ptr: number, type: string): number | bigint;
  setValue(ptr: number, value: number, type: string): void;
  UTF8ToString(ptr: number): string;
  stringToUTF8(value: string, ptr: number, maxBytes: number): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  ENV?: Record<string, string>;
  FS: EmscriptenFileSystem;
  IDBFS?: unknown;
}

interface NethackGlobals {
  svp?: { plname?: string };
  iflags?: {
    wc2_hitpointbar?: boolean;
    window_inited?: boolean;
  };
  flags?: {
    initrole?: number;
    initrace?: number;
    initgend?: number;
    initalign?: number;
  };
}

interface NethackGlobal {
  globals?: NethackGlobals;
  pointers?: { extcmdlist?: number };
}

declare global {
  var nethackGlobal: NethackGlobal | undefined;
}

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

export type EmscriptenFactory = (
  options: Record<string, unknown>,
) => Promise<EmscriptenModule>;

/** Session guard used while a module factory is still loading asynchronously. */
export interface GameModuleOptions {
  isCurrent?: () => boolean;
}

const MENU_ITEM_SIZE = 16;
const MENU_ITEM_COUNT_OFFSET = 8;
const MENU_ITEM_FLAGS_OFFSET = 12;
const GETLIN_BUFFER_SIZE = 256;
const PLAYER_NAME_BUFFER_SIZE = 32;
const KEY_QUEUE_LIMIT = 2;
const SAVE_COMMAND = "S".charCodeAt(0);
const SAVE_CONFIRM_QUERY = "Really save?";
const YES_RESPONSE = "y".charCodeAt(0);
const BL_ATTCLR_MAX = 24;
const EXTCMD_ENTRY_SIZE = 24;
const EXTCMD_TEXT_OFFSET = 4;
const EXTCMD_DESCRIPTION_OFFSET = 8;
const EXTCMD_FLAGS_OFFSET = 16;
const WIZMODECMD = 0x0004;
const CMD_NOT_AVAILABLE = 0x0010;
const INTERNALCMD = 0x0040;

let pendingAction: PendingAction | null = null;
const queuedKeys: number[] = [];
let typeaheadEnabled = false;
let saveExitAutomation: "confirm" | "display" | null = null;
let knownSaveNames: string[] = [];
let pendingRuntimeSettings: RuntimeNetHackSettings | null = null;

/**
 * Remove Emscripten's synthetic login name before NetHack calls whoami().
 * This makes plnamesuffix() invoke askname before save lookup and role selection.
 * @param module - initialized Emscripten module.
 */
export function preparePlayerNamePrompt(module: EmscriptenModule): void {
  module.ENV ??= {};
  module.ENV.USER = "";
  module.ENV.LOGNAME = "";
}

/**
 * Supply names which askname may resolve to an existing save.
 * @param names - validated names enumerated by the current Home module.
 */
export function setKnownSaveNames(names: string[]): void {
  knownSaveNames = [...new Set(names)];
}

/**
 * Queue one complete dynamic settings update for the next safe command boundary.
 * @param settings - validated profile settings; tutorial is startup-only.
 */
export function queueRuntimeSettings(settings: NetHackSettingsV1): void {
  pendingRuntimeSettings = runtimeSettingsFromProfile(settings);
  setRuntimeSettingsStatus("pending");
}

/**
 * Apply exactly the same cleanup used when a player name is submitted.
 * @param value - current name input.
 * @returns the value NetHack receives.
 */
export function normalizePlayerNameInput(value: string): string {
  return truncateUtf8(value.trim(), PLAYER_NAME_BUFFER_SIZE - 1);
}

/**
 * Set the identity NetHack will use for save lookup when main starts.
 * @param module - prepared module which has not called main.
 * @param identity - validated identity read from the selected save.
 */
export function setStartupIdentity(
  module: EmscriptenModule,
  identity: SaveIdentity,
): void {
  module.ccall(
    "shim_graphics_set_player_name",
    null,
    ["string"],
    [identity.playerName],
  );
}

/**
 * Require this module to restore rather than fall through to character setup.
 * @param module - prepared module which has not called main.
 * @param required - whether player selection represents restore failure.
 */
export function setRestoreRequired(
  module: EmscriptenModule,
  required: boolean,
): void {
  module.ccall(
    "shim_graphics_set_restore_required",
    null,
    ["number"],
    [required ? 1 : 0],
  );
}

/**
 * Validate a save with NetHack's own header reader and return its identity.
 * @param storageModule - module which owns the save file.
 * @param path - absolute virtual save path.
 * @returns a ready identity or an explicit invalid result.
 */
export async function validateSaveMetadata(
  storageModule: StorageModule,
  path: string,
): Promise<SaveValidation> {
  const fileData = storageModule.FS.readFile(path);
  if (typeof fileData === "string") {
    return { status: "damaged", reason: "not-binary" };
  }
  const validation = await validateSaveBytes(storageModule, fileData);
  if (validation.status !== "ready") return validation;

  const fileName = path.slice(path.lastIndexOf("/") + 1);
  if (fileName !== `0${validation.identity.playerName}`) {
    return {
      status: "damaged",
      reason: "identity-file-name-mismatch",
    };
  }
  return validation;
}

/**
 * Validate raw save bytes before they are allowed into the formal save path.
 * @param storageModule - module which supplies the current build fingerprint.
 * @param fileData - untrusted uploaded bytes.
 * @returns a ready identity or an explicit invalid result.
 */
export async function validateSaveBytes(
  storageModule: StorageModule,
  fileData: Uint8Array,
): Promise<SaveValidation> {
  const module = storageModule as unknown as EmscriptenModule;
  const outputSize = 256;
  const outputPtr = module._malloc(outputSize);
  try {
    const fingerprintSize = Number(module.ccall(
      "shim_graphics_get_save_fingerprint",
      "number",
      ["number", "number"],
      [outputPtr, outputSize],
    ));
    if (
      !Number.isInteger(fingerprintSize)
      || fingerprintSize <= 0
      || fingerprintSize > outputSize
    ) {
      throw new Error("Current save fingerprint is unavailable");
    }

    if (fileData.length < fingerprintSize + 4 + 49) {
      return { status: "damaged", reason: "truncated" };
    }
    for (let index = 0; index < fingerprintSize; index += 1) {
      if (
        fileData[index]
        !== (Number(module.getValue(outputPtr + index, "i8")) & 0xff)
      ) {
        return {
          status: "incompatible",
          reason: "fingerprint-mismatch",
        };
      }
    }

    const identitySize = new DataView(
      fileData.buffer,
      fileData.byteOffset + fingerprintSize,
      4,
    ).getInt32(0, true);
    if (identitySize !== 49) {
      return { status: "damaged", reason: "invalid-identity-size" };
    }
    const identity = fileData.subarray(
      fingerprintSize + 4,
      fingerprintSize + 4 + identitySize,
    );
    const nameEnd = identity.indexOf(0);
    if (nameEnd <= 0) {
      return { status: "damaged", reason: "invalid-player-name" };
    }
    const detailsEnd = identity.indexOf(0, nameEnd + 1);
    if (detailsEnd <= nameEnd + 1) {
      return {
        status: "damaged",
        reason: "invalid-character-identity",
      };
    }
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const playerName = decoder.decode(identity.subarray(0, nameEnd));
      const details = decoder.decode(
        identity.subarray(nameEnd + 1, detailsEnd),
      ).split("-");
      if (
        !playerName
        || details.length !== 4
        || details.some((value) => !/^[A-Za-z]{3}$/.test(value))
      ) {
        return {
          status: "damaged",
          reason: "invalid-character-identity",
        };
      }
      const [role, race, gender, alignment] = details;
      return {
        status: "ready",
        identity: { playerName, role, race, gender, alignment },
      };
    } catch {
      return {
        status: "damaged",
        reason: "invalid-character-identity",
      };
    }
  } finally {
    module._free(outputPtr);
  }
}

/**
 * Load one fresh NetHack module without registering callbacks or running main.
 * @param wasmUrl - URL of the Emscripten ES module loader.
 * @param options - session guard for asynchronous loader output.
 * @returns the initialized Emscripten module.
 */
export async function createGameModule(
  wasmUrl = `${import.meta.env.BASE_URL}nethack.js`,
  options: GameModuleOptions = {},
): Promise<EmscriptenModule> {
  const isCurrent = options.isCurrent ?? (() => true);
  const loaderUrl = new URL(wasmUrl, globalThis.location.href).href;
  const imported = await import(/* @vite-ignore */ loaderUrl) as {
    default: EmscriptenFactory;
  };
  return imported.default({
    noInitialRun: true,
    locateFile: (path: string) => new URL(path, loaderUrl).href,
    preRun: (runtimeModule: EmscriptenModule) =>
      preparePlayerNamePrompt(runtimeModule),
    print: (text: string) => {
      if (isCurrent()) appendWindowText(-1, 0, text);
    },
    printErr: (text: string) => {
      if (isCurrent()) appendWindowText(-1, ATR_BOLD, text);
    },
  });
}

/**
 * Resolve the active keyboard-facing callback with one NetHack byte.
 * @param value - unsigned non-zero byte produced by keyboard.ts.
 */
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

/**
 * Send the native save command and skip its immediate confirmation and display.
 * The intent is armed only while the core is waiting for a top-level command.
 * @returns nothing; unsupported input states leave the bridge unchanged.
 */
export function requestSaveAndExit(): void {
  if (pendingAction?.kind !== "key" || !pendingAction.commandInput) return;
  saveExitAutomation = "confirm";
  sendKey(SAVE_COMMAND);
}

/**
 * Resolve nh_poskey with a map position and mouse button modifier.
 * @param x - NetHack map column.
 * @param y - NetHack map row.
 * @param modifier - CLICK_1 (1) or CLICK_2 (2).
 */
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

/**
 * Submit a name or getlin response.
 * @param value - entered text, or null to cancel getlin.
 */
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

/**
 * Submit selected rows from an active NetHack menu.
 * @param selected - selected row indexes and counts, or null for explicit cancel.
 */
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

/**
 * Submit an extended-command source index, or cancel with null.
 * @param sourceIndex - index into extcmdlist, or null.
 */
export function submitExtendedCommand(sourceIndex: number | null): void {
  const pending = pendingAction;
  if (pending?.kind !== "extcmd") return;
  pendingAction = null;
  clearModal();
  pending.resolve(sourceIndex ?? -1);
}

/**
 * Dismiss a blocking text/history display or a PICK_NONE menu.
 */
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

/**
 * Report whether any shim callback is currently waiting for user input.
 * @returns true while Asyncify is suspended for input.
 */
export function isWaitingForInput(): boolean {
  return pendingAction !== null;
}

/**
 * Reset bridge and frontend state for tests or a future fresh game.
 */
export function resetBridgeState(): void {
  pendingAction = null;
  pendingRuntimeSettings = null;
  queuedKeys.length = 0;
  typeaheadEnabled = false;
  saveExitAutomation = null;
  knownSaveNames = [];
  resetGameState();
}

/**
 * Dispatch a callback using the module captured by its owning session.
 * @param module - module whose memory contains all callback pointers.
 * @param name - exact function name from winshim.c.
 * @param args - values decoded by local_callback.
 * @returns the value required by the callback's C return type.
 */
export async function shimCallbackForModule(
  module: EmscriptenModule,
  name: string,
  ...args: unknown[]
): Promise<unknown> {
  try {
    return await dispatchShimCallback(module, name, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setRuntimeError(`${name}: ${message}`);
    return safeCallbackResult(name);
  }
}

/**
 * Dispatch one callback after the public boundary has installed error handling.
 * @param name - exact function name from winshim.c.
 * @param args - values decoded by local_callback.
 * @returns the value required by the callback's C return type.
 */
async function dispatchShimCallback(
  module: EmscriptenModule,
  name: string,
  args: unknown[],
): Promise<unknown> {
  switch (name) {
    case "shim_init_nhwindows": {
      const iflags = globalThis.nethackGlobal?.globals?.iflags;
      if (iflags) {
        iflags.window_inited = true;
        iflags.wc2_hitpointbar = true;
      }
      setRuntimePhase("running");
      return undefined;
    }
    case "shim_player_selection_or_tty":
      return true;
    case "shim_askname":
      return waitForLine(module, "name", "Who are you?", 0);
    case "shim_get_nh_event":
    case "shim_suspend_nhwindows":
    case "shim_resume_nhwindows":
      return undefined;
    case "shim_settings_sync":
      return synchronizeRuntimeSettings(asNumber(args[0]));
    case "shim_settings_result":
      acceptRuntimeSettingsResult(
        asNumber(args[0]),
        asNumber(args[1]),
      );
      return undefined;
    case "shim_exit_nhwindows":
      setExitReason(asString(args[0]));
      return undefined;
    case "shim_create_nhwindow":
      return createWindow(asNumber(args[0]));
    case "shim_clear_nhwindow":
      clearWindow(asNumber(args[0]));
      return undefined;
    case "shim_display_nhwindow":
      return displayWindow(asNumber(args[0]), Boolean(args[1]));
    case "shim_destroy_nhwindow":
      destroyWindow(asNumber(args[0]));
      return undefined;
    case "shim_curs":
      setCursor(asNumber(args[0]), asNumber(args[1]), asNumber(args[2]));
      return undefined;
    case "shim_putstr":
      appendWindowText(
        asNumber(args[0]),
        asNumber(args[1]),
        asString(args[2]),
      );
      return undefined;
    case "shim_display_file":
      return displayFile(module, asString(args[0]), Boolean(args[1]));
    case "shim_start_menu":
      beginMenu(asNumber(args[0]), asNumber(args[1]));
      return undefined;
    case "shim_add_menu":
      addDecodedMenuItem(module, args);
      return undefined;
    case "shim_end_menu":
      endMenu(asNumber(args[0]), asString(args[1]));
      return undefined;
    case "shim_select_menu":
      return selectMenu(
        module,
        asNumber(args[0]),
        asNumber(args[1]),
        asNumber(args[2]),
      );
    case "shim_message_menu":
      return messageMenu(
        asNumber(args[0]) & 0xff,
        asNumber(args[1]),
        asString(args[2]),
      );
    case "shim_mark_synch":
    case "shim_wait_synch":
      flushDisplay();
      return undefined;
    case "shim_cliparound":
      setClipCenter(asNumber(args[0]), asNumber(args[1]));
      return undefined;
    case "shim_update_positionbar":
      return undefined;
    case "shim_print_glyph":
      printGlyph(module, args);
      return undefined;
    case "shim_raw_print":
      appendWindowText(-1, 0, asString(args[0]));
      return undefined;
    case "shim_raw_print_bold":
      appendWindowText(-1, ATR_BOLD, asString(args[0]));
      return undefined;
    case "shim_nhgetch":
      return waitForKey(module, null, asNumber(args[0]) === 1);
    case "shim_nh_poskey":
      return waitForKey(module, {
        x: asNumber(args[0]),
        y: asNumber(args[1]),
        modifier: asNumber(args[2]),
      }, asNumber(args[3]) === 1);
    case "shim_nhbell":
      ringBell();
      return undefined;
    case "shim_doprev_message":
      return displayHistory();
    case "shim_yn_function":
      return waitForYn(
        asString(args[0]) || null,
        asString(args[1]) || null,
        asNumber(args[2]),
      );
    case "shim_getlin":
      return waitForLine(
        module,
        "getlin",
        asString(args[0]),
        asNumber(args[1]),
      );
    case "shim_get_ext_cmd":
      return waitForExtendedCommand(module);
    case "shim_number_pad":
      setNumberPad(asNumber(args[0]) !== 0);
      return undefined;
    case "shim_delay_output":
      await delay(50);
      return undefined;
    case "shim_preference_update":
      setLastPreference(readStringPointer(module, asNumber(args[0])));
      return undefined;
    case "shim_getmsghistory":
      // Upstream's "s" return setter writes into the char* stack slot rather
      // than assigning a pointer. An empty string safely leaves that slot NULL.
      return "";
    case "shim_putmsghistory":
      putMessageHistory(
        asString(args[0]) || null,
        Boolean(args[1]),
      );
      return undefined;
    case "shim_status_init":
      resetStatus();
      return undefined;
    case "shim_status_enablefield":
      return undefined;
    case "shim_status_update":
      updateDecodedStatus(module, args);
      return undefined;
    case "shim_change_color":
    case "shim_change_background":
      return undefined;
    case "set_shim_font_name":
      return 0;
    case "shim_get_color_string":
      return "";
    default:
      setRuntimeError(`Unsupported shim callback: ${name}`);
      return undefined;
  }
}

/**
 * Convert an unknown decoded callback argument to a finite number.
 * @param value - decoded callback argument.
 * @returns a finite number, or zero for an absent value.
 */
function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Convert an unknown decoded callback argument to a string.
 * @param value - decoded callback argument.
 * @returns the supplied string or an empty string.
 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Return a correctly typed fallback so local_callback can always wake Asyncify.
 * @param name - callback whose implementation failed.
 * @returns a conservative value matching that callback's C return type.
 */
function safeCallbackResult(name: string): unknown {
  if (name === "shim_player_selection_or_tty") return true;
  if (name === "shim_settings_sync") return 0;
  if (
    name === "shim_create_nhwindow"
    || name === "shim_select_menu"
    || name === "shim_get_ext_cmd"
  ) {
    return -1;
  }
  if (name === "shim_nhgetch" || name === "shim_nh_poskey") return 27;
  if (name === "shim_yn_function" || name === "shim_message_menu") return 27;
  if (name === "shim_doprev_message" || name === "set_shim_font_name") return 0;
  if (name === "shim_getmsghistory" || name === "shim_get_color_string") return "";
  return undefined;
}

/** Publish the core snapshot and return one queued, versioned update. */
function synchronizeRuntimeSettings(snapshotPayload: number): number {
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
function acceptRuntimeSettingsResult(
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

/**
 * Read a NUL-terminated string from one raw callback pointer.
 * @param ptr - WASM string address.
 * @returns decoded UTF-8 text or an empty string for NULL.
 */
function readStringPointer(module: EmscriptenModule, ptr: number): string {
  return ptr === 0 ? "" : module.UTF8ToString(ptr);
}

/**
 * Decode one glyph_info using the verified Emscripten WASM32 layout.
 * @param ptr - glyph_info memory address.
 * @returns decoded glyph metadata, or null for NULL.
 */
function readGlyph(
  module: EmscriptenModule,
  ptr: number,
): GlyphInfo | null {
  if (ptr === 0) return null;
  return {
    glyph: Number(module.getValue(ptr, "i32")),
    ttyChar: Number(module.getValue(ptr + 4, "i32")),
    frameColor: Number(module.getValue(ptr + 8, "i32")) >>> 0,
    glyphFlags: Number(module.getValue(ptr + 12, "i32")) >>> 0,
    color: Number(module.getValue(ptr + 16, "i32")),
    symbolIndex: Number(module.getValue(ptr + 20, "i32")),
    customColor: Number(module.getValue(ptr + 24, "i32")) >>> 0,
    color256: Number(module.getValue(ptr + 28, "i16")) & 0xffff,
    tileIndex: Number(module.getValue(ptr + 30, "i16")),
  };
}

/**
 * Decode and buffer one print_glyph callback.
 * @param args - callback arguments in winshim.c order.
 */
function printGlyph(module: EmscriptenModule, args: unknown[]): void {
  const x = asNumber(args[1]);
  const y = asNumber(args[2]);
  const foreground = readGlyph(module, asNumber(args[3]));
  if (!foreground) return;
  setMapCell(x, y, foreground, readGlyph(module, asNumber(args[4])));
}

/**
 * Copy and append one add_menu callback while its pointers are valid.
 * @param args - callback arguments in winshim.c order.
 */
function addDecodedMenuItem(
  module: EmscriptenModule,
  args: unknown[],
): void {
  const identifierValue = asNumber(args[2]);
  addMenuItem(asNumber(args[0]), {
    glyph: readGlyph(module, asNumber(args[1])),
    identifier: identifierValue === 0 ? null : identifierValue,
    accelerator: asNumber(args[3]) & 0xff,
    groupAccelerator: asNumber(args[4]) & 0xff,
    attribute: asNumber(args[5]),
    color: asNumber(args[6]),
    text: asString(args[7]),
    itemFlags: asNumber(args[8]) >>> 0,
  });
}

/**
 * Display a window and optionally wait for user acknowledgement.
 * @param winid - window to display.
 * @param blocking - whether the core requires acknowledgement.
 * @returns immediately or after the active display is dismissed.
 */
function displayWindow(
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
  return new Promise<void>((resolve) => {
    setPending({
      kind: "display",
      resolve,
    });
  });
}

/**
 * Read and display one embedded NetHack data file.
 * @param name - path passed by the core.
 * @param complain - whether a missing file should produce a message.
 */
async function displayFile(
  module: EmscriptenModule,
  name: string,
  complain: boolean,
): Promise<void> {
  let content: string;
  try {
    const result = module.FS.readFile("/nhdat");
    const archive = typeof result === "string"
      ? new TextEncoder().encode(result)
      : result;
    const entry = readDlbEntry(archive, name);
    if (entry === null) throw new Error(`Missing DLB entry: ${name}`);
    content = new TextDecoder().decode(entry);
  } catch {
    if (complain) appendWindowText(-1, 0, `Cannot display file: ${name}`);
    return;
  }
  const lines = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((text): TextLine => ({ text, attribute: 0 }));
  showText(name, lines);
  await new Promise<void>((resolve) => {
    setPending({ kind: "display", resolve });
  });
}

/**
 * Display a built menu and wait for its selection result.
 * @param winid - menu window ID.
 * @param how - PICK_* selection mode.
 * @param menuListPtr - address of the output menu_item pointer.
 * @returns selected count, zero, or minus one.
 */
function selectMenu(
  module: EmscriptenModule,
  winid: number,
  how: number,
  menuListPtr: number,
): Promise<number> | number {
  if (menuListPtr !== 0) module.setValue(menuListPtr, 0, "*");
  const window = getWindow(winid);
  if (window && (window.menuBehavior & MENU_BEHAVE_PERMINV) !== 0) {
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

/**
 * Implement the single-line message-menu contract.
 * @param acceptedCode - low byte of the shim's misdeclared char argument.
 * @param how - PICK_NONE or PICK_ONE.
 * @param message - text to display.
 * @returns zero immediately or a pending response byte.
 */
function messageMenu(
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

/**
 * Wait for keyboard or mouse input requested by the core.
 * @param positionPointers - nh_poskey output pointers, or null for nhgetch.
 * @param commandInput - whether this is the top-level command prompt.
 * @returns the input code after user interaction.
 */
function waitForKey(
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

/**
 * Wait for and normalize a yn_function response.
 * @param query - prompt text.
 * @param choices - accepted lower-case choices, or null for any byte.
 * @param defaultCode - response used by Space, Return, and Enter.
 */
function waitForYn(
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

/**
 * Wait for player-name or getlin text entry.
 * @param purpose - destination of the submitted text.
 * @param query - prompt text.
 * @param bufferPtr - getlin output buffer, or zero for player name.
 */
function waitForLine(
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

/**
 * Normalize one response according to doc/window.txt yn_function rules.
 * @param value - raw NetHack key byte.
 * @param choices - valid responses, including optional hidden choices.
 * @param defaultCode - default response byte.
 * @returns an accepted byte, or null to keep waiting.
 */
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

/**
 * Show message history and wait until the player dismisses it.
 * @returns zero after dismissal.
 */
function displayHistory(): Promise<number> {
  showHistory();
  return new Promise<number>((resolve) => {
    setPending({ kind: "display", resolve: () => resolve(0) });
  });
}

/**
 * Parse extcmdlist and wait for a command selection.
 * @returns the source array index or minus one on cancellation.
 */
function waitForExtendedCommand(
  module: EmscriptenModule,
): Promise<number> | number {
  const commands = readExtendedCommands(module);
  if (commands.length === 0) return -1;
  showExtendedCommands(commands);
  return new Promise<number>((resolve) => {
    setPending({ kind: "extcmd", resolve });
  });
}

/**
 * Parse user-visible entries from the exposed extcmdlist pointer.
 * @returns commands with their original array indexes.
 */
function readExtendedCommands(module: EmscriptenModule): ExtendedCommand[] {
  const listPtr = globalThis.nethackGlobal?.pointers?.extcmdlist ?? 0;
  if (listPtr === 0) return [];
  const commands: ExtendedCommand[] = [];

  for (let index = 0; index < 1024; index += 1) {
    const entryPtr = listPtr + index * EXTCMD_ENTRY_SIZE;
    const textPtr = Number(module.getValue(entryPtr + EXTCMD_TEXT_OFFSET, "*"));
    if (textPtr === 0) break;
    const flags = Number(
      module.getValue(entryPtr + EXTCMD_FLAGS_OFFSET, "i32"),
    ) >>> 0;
    if ((flags & (WIZMODECMD | CMD_NOT_AVAILABLE | INTERNALCMD)) !== 0) continue;
    const descriptionPtr = Number(
      module.getValue(entryPtr + EXTCMD_DESCRIPTION_OFFSET, "*"),
    );
    commands.push({
      sourceIndex: index,
      name: module.UTF8ToString(textPtr),
      description: descriptionPtr === 0
        ? ""
        : module.UTF8ToString(descriptionPtr),
    });
  }
  return commands;
}

/**
 * Decode and buffer one status_update callback.
 * @param args - callback arguments in winshim.c order.
 */
function updateDecodedStatus(
  module: EmscriptenModule,
  args: unknown[],
): void {
  const field = asNumber(args[0]);
  if (field === BL_FLUSH) {
    flushStatus();
    return;
  }
  if (field === BL_RESET) {
    flushStatus();
    return;
  }

  const valuePtr = asNumber(args[1]);
  const packedColor = asNumber(args[4]) >>> 0;
  const conditionColors: number[] = [];
  let text = "";
  let conditionMask: number | undefined;

  if (field === BL_CONDITION) {
    conditionMask = valuePtr === 0
      ? 0
      : Number(module.getValue(valuePtr, "i32")) >>> 0;
    const masksPtr = asNumber(args[5]);
    if (masksPtr !== 0) {
      for (let index = 0; index < BL_ATTCLR_MAX; index += 1) {
        conditionColors.push(
          Number(module.getValue(masksPtr + index * 4, "i32")) >>> 0,
        );
      }
    }
  } else {
    text = decodeStatusText(field, readStringPointer(module, valuePtr));
  }

  setStatusValue(field, {
    text,
    change: asNumber(args[2]),
    percent: asNumber(args[3]),
    color: packedColor & 0xff,
    attributes: packedColor >>> 8,
    conditionMask,
    conditionColors,
  });
}

/**
 * Decode field-specific mixed text emitted by the status subsystem.
 * @param field - BL_* field index.
 * @param text - formatted field text from the core.
 * @returns terminal-ready text.
 */
function decodeStatusText(field: number, text: string): string {
  const decoded = field === BL_GOLD
    ? text.replace(/\\G[0-9A-Fa-f]{8}/g, "$")
    : text;
  const format = STATUS_FORMATS[field];
  return format ? `${format[0]}${decoded}${format[1]}` : decoded;
}

const STATUS_FORMATS: Readonly<Record<number, readonly [string, string]>> = {
  0: ["", ""],
  1: [" St:", ""],
  2: [" Dx:", ""],
  3: [" Co:", ""],
  4: [" In:", ""],
  5: [" Wi:", ""],
  6: [" Ch:", ""],
  7: [" ", ""],
  8: [" S:", ""],
  9: [" ", ""],
  10: [" ", ""],
  11: [" Pw:", ""],
  12: ["(", ")"],
  13: [" Xp:", ""],
  14: [" AC:", ""],
  15: [" HD:", ""],
  16: [" T:", ""],
  17: [" ", ""],
  18: [" HP:", ""],
  19: ["(", ")"],
  20: ["", ""],
  21: ["/", ""],
  23: [" ", ""],
  24: [" ", ""],
  25: [" ", ""],
  26: [" ", ""],
};

/**
 * Install one pending Asyncify action and reject impossible reentry.
 * @param action - callback-specific pending resolver.
 */
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

/**
 * Truncate a string without splitting a UTF-8 code point.
 * @param value - source string.
 * @param maxBytes - maximum encoded payload bytes.
 * @returns the longest prefix within the byte limit.
 */
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

/**
 * Resolve after a fixed number of milliseconds.
 * @param milliseconds - requested delay.
 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
