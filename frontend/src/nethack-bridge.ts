/**
 * Stable façade for the NetHack 5.0 shim_graphics callback bridge.
 * Contracts are derived from win/shim/winshim.c and doc/window.txt.
 */

import {
  ATR_BOLD,
  appendWindowText,
  beginMenu,
  clearWindow,
  createWindow,
  destroyWindow,
  endMenu,
  flushDisplay,
  putMessageHistory,
  resetGameState,
  resetStatus,
  ringBell,
  setClipCenter,
  setCursor,
  setExitReason,
  setLastPreference,
  setNumberPad,
  setRuntimeError,
  setRuntimePhase,
  showText,
  type TextLine,
} from "./game-state";
import { readDlbEntry } from "./dlb";
import type { SaveIdentity } from "./storage/storage-service";
import type { EmscriptenModule } from "./bridge/emscripten-module";
import {
  acceptRuntimeSettingsResult,
  dismissDisplay,
  displayHistory,
  displayWindow,
  isWaitingForInput,
  messageMenu,
  normalizePlayerNameInput,
  queueRuntimeSettings,
  requestSaveAndExit,
  resetInputController,
  selectMenu,
  sendKey,
  sendPosition,
  setKnownSaveNames,
  submitExtendedCommand,
  submitLine,
  submitMenuSelection,
  synchronizeRuntimeSettings,
  waitForDisplay,
  waitForExtendedCommand,
  waitForKey,
  waitForLine,
  waitForYn,
} from "./bridge/input-controller";
import {
  addDecodedMenuItem,
  asNumber,
  asString,
  printGlyph,
  readStringPointer,
  safeCallbackResult,
  updateDecodedStatus,
} from "./bridge/shim-decoders";

export {
  createGameModule,
  preparePlayerNamePrompt,
} from "./bridge/emscripten-module";
export type {
  EmscriptenFactory,
  EmscriptenFileSystem,
  EmscriptenModule,
  GameModuleOptions,
} from "./bridge/emscripten-module";
export {
  validateSaveBytes,
  validateSaveMetadata,
} from "./bridge/save-validation";
export {
  dismissDisplay,
  isWaitingForInput,
  normalizePlayerNameInput,
  queueRuntimeSettings,
  requestSaveAndExit,
  sendKey,
  sendPosition,
  setKnownSaveNames,
  submitExtendedCommand,
  submitLine,
  submitMenuSelection,
};

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

/** Reset bridge and frontend state for tests or a future fresh game. */
export function resetBridgeState(): void {
  resetInputController();
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
  await waitForDisplay();
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
