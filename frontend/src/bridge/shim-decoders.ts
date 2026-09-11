import {
  BL_CONDITION,
  BL_FLUSH,
  BL_GOLD,
  BL_RESET,
  addMenuItem,
  flushStatus,
  setMapCell,
  setStatusValue,
  type ExtendedCommand,
  type GlyphInfo,
} from "../game-state";
import type { EmscriptenModule } from "./emscripten-module";

const BL_ATTCLR_MAX = 24;
const EXTCMD_ENTRY_SIZE = 24;
const EXTCMD_TEXT_OFFSET = 4;
const EXTCMD_DESCRIPTION_OFFSET = 8;
const EXTCMD_FLAGS_OFFSET = 16;
const WIZMODECMD = 0x0004;
const CMD_NOT_AVAILABLE = 0x0010;
const INTERNALCMD = 0x0040;

/** Convert a decoded callback argument to a finite number. */
export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Convert a decoded callback argument to a string. */
export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Return a conservative value matching a failed callback's C return type. */
export function safeCallbackResult(name: string): unknown {
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

/** Read a NUL-terminated string from one raw callback pointer. */
export function readStringPointer(
  module: EmscriptenModule,
  ptr: number,
): string {
  return ptr === 0 ? "" : module.UTF8ToString(ptr);
}

/** Decode and buffer one print_glyph callback. */
export function printGlyph(
  module: EmscriptenModule,
  args: unknown[],
): void {
  const x = asNumber(args[1]);
  const y = asNumber(args[2]);
  const foreground = readGlyph(module, asNumber(args[3]));
  if (!foreground) return;
  setMapCell(x, y, foreground, readGlyph(module, asNumber(args[4])));
}

/** Copy and append one add_menu callback while its pointers are valid. */
export function addDecodedMenuItem(
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

/** Parse user-visible entries from the exposed extcmdlist pointer. */
export function readExtendedCommands(
  module: EmscriptenModule,
): ExtendedCommand[] {
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

/** Decode and buffer one status_update callback. */
export function updateDecodedStatus(
  module: EmscriptenModule,
  args: unknown[],
): void {
  const field = asNumber(args[0]);
  if (field === BL_FLUSH || field === BL_RESET) {
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
