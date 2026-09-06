import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATR_NOHISTORY,
  BL_CONDITION,
  BL_FLUSH,
  BL_GOLD,
  BL_RESET,
  MENU_BEHAVE_PERMINV,
  NHW_MAP,
  NHW_MENU,
  NHW_MESSAGE,
  NHW_TEXT,
  PICK_ANY,
  PICK_NONE,
  PICK_ONE,
  getSnapshot,
  getWindow,
} from "./game-state";
import {
  dismissDisplay,
  isWaitingForInput,
  normalizePlayerNameInput,
  preparePlayerNamePrompt,
  queueRuntimeSettings,
  requestSaveAndExit,
  resetBridgeState,
  sendKey,
  sendPosition,
  setKnownSaveNames,
  setRestoreRequired,
  setStartupIdentity,
  shimCallbackForModule,
  submitExtendedCommand,
  submitLine,
  submitMenuSelection,
  validateSaveBytes,
  validateSaveMetadata,
  type EmscriptenModule,
} from "./nethack-bridge";
import { createDefaultProfile } from "./settings/profile";
import { encodeRuntimeSettings } from "./settings/runtime-settings-protocol";

interface MockModuleHarness {
  module: EmscriptenModule;
  files: Map<string, string | Uint8Array>;
  memory: Uint8Array;
  readI16: (ptr: number) => number;
  readI32: (ptr: number) => number;
  writeI16: (ptr: number, value: number) => void;
  writeI32: (ptr: number, value: number) => void;
  writeString: (ptr: number, value: string) => void;
}

/**
 * Create an in-memory Emscripten module with the APIs used by the bridge.
 * @returns a module and direct helpers for arranging WASM fixtures.
 */
function createMockModule(): MockModuleHarness {
  const memory = new Uint8Array(128 * 1024);
  const view = new DataView(memory.buffer);
  const files = new Map<string, string | Uint8Array>();
  let nextAllocation = 0x8000;

  /** Read a signed 16-bit value from mock WASM memory. */
  const readI16 = (ptr: number): number => view.getInt16(ptr, true);
  /** Read a signed 32-bit value from mock WASM memory. */
  const readI32 = (ptr: number): number => view.getInt32(ptr, true);
  /** Write a signed 16-bit value to mock WASM memory. */
  const writeI16 = (ptr: number, value: number): void => view.setInt16(ptr, value, true);
  /** Write a signed 32-bit value to mock WASM memory. */
  const writeI32 = (ptr: number, value: number): void => view.setInt32(ptr, value, true);

  /**
   * Write a NUL-terminated UTF-8 string to mock WASM memory.
   * @param ptr - destination memory address.
   * @param value - string to encode.
   */
  const writeString = (ptr: number, value: string): void => {
    const encoded = new TextEncoder().encode(value);
    memory.set(encoded, ptr);
    memory[ptr + encoded.length] = 0;
  };

  const module: EmscriptenModule = {
    ccall: vi.fn(),
    getValue: vi.fn((ptr: number, type: string) => {
      if (type === "i8") return view.getInt8(ptr);
      if (type === "i16") return view.getInt16(ptr, true);
      if (type === "i32") return view.getInt32(ptr, true);
      if (type === "*") return view.getUint32(ptr, true);
      throw new Error(`unsupported mock getValue type: ${type}`);
    }),
    setValue: vi.fn((ptr: number, value: number, type: string) => {
      if (type === "i8") view.setInt8(ptr, value);
      else if (type === "i16") view.setInt16(ptr, value, true);
      else if (type === "i32") view.setInt32(ptr, value, true);
      else if (type === "*") view.setUint32(ptr, value, true);
      else throw new Error(`unsupported mock setValue type: ${type}`);
    }),
    UTF8ToString: vi.fn((ptr: number) => {
      let end = ptr;
      while (memory[end] !== 0) end += 1;
      return new TextDecoder().decode(memory.subarray(ptr, end));
    }),
    stringToUTF8: vi.fn((value: string, ptr: number, maxBytes: number) => {
      const encoded = new TextEncoder().encode(value);
      const length = Math.min(encoded.length, maxBytes - 1);
      memory.set(encoded.subarray(0, length), ptr);
      memory[ptr + length] = 0;
    }),
    _malloc: vi.fn((size: number) => {
      const ptr = nextAllocation;
      nextAllocation += Math.ceil(size / 8) * 8;
      return ptr;
    }),
    _free: vi.fn(),
    ENV: {
      LOGNAME: "web_user",
      USER: "web_user",
    },
    IDBFS: {},
    FS: {
      analyzePath: vi.fn((path: string) => ({ exists: files.has(path) })),
      mkdir: vi.fn((path: string) => {
        files.set(path, new Uint8Array());
      }),
      mount: vi.fn(),
      readFile: vi.fn((path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`ENOENT: ${path}`);
        return value;
      }),
      syncfs: vi.fn((_populate: boolean, callback: (error: unknown) => void) => {
        callback(null);
      }),
    },
  };

  return {
    module,
    files,
    memory,
    readI16,
    readI32,
    writeI16,
    writeI32,
    writeString,
  };
}

/**
 * Build a revision-1 DLB archive matching src/dlb.c's documented layout.
 * @param entries - logical archive names and byte content.
 * @returns complete archive bytes.
 */
function createDlbArchive(entries: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const names = Object.keys(entries);
  const entryCount = names.length + 1;
  const stringSize = "Directory".length + 1
    + names.reduce((total, name) => total + name.length + 1, 0);
  const placeholderHeader =
    `${String(1).padStart(3)} ${String(entryCount).padStart(8)} `
    + `${String(stringSize).padStart(8)} ${String(0).padStart(8)} `
    + `${String(0).padStart(8)}\n`;
  const placeholderDirectory = [
    `nDirectory ${String(0).padStart(8)}\n`,
    ...names.map((name) => `n${name} ${String(0).padStart(8)}\n`),
  ].join("");
  const dataOffset = encoder.encode(placeholderHeader + placeholderDirectory).length;
  const encodedEntries = names.map((name) => encoder.encode(entries[name]));
  let nextOffset = dataOffset;
  const directoryLines = [`nDirectory ${String(0).padStart(8)}\n`];
  names.forEach((name, index) => {
    directoryLines.push(`n${name} ${String(nextOffset).padStart(8)}\n`);
    nextOffset += encodedEntries[index].length;
  });
  const header =
    `${String(1).padStart(3)} ${String(entryCount).padStart(8)} `
    + `${String(stringSize).padStart(8)} ${String(dataOffset).padStart(8)} `
    + `${String(nextOffset).padStart(8)}\n`;
  const prefix = encoder.encode(header + directoryLines.join(""));
  const archive = new Uint8Array(nextOffset);
  archive.set(prefix);
  let offset = dataOffset;
  for (const entry of encodedEntries) {
    archive.set(entry, offset);
    offset += entry.length;
  }
  return archive;
}

/**
 * Confirm that a Promise has not settled after the current microtask queue.
 * @param promise - Promise expected to remain pending.
 */
async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
}

let harness: MockModuleHarness;

/**
 * Dispatch a callback against the module owned by the current test.
 * @param name - shim callback name.
 * @param args - decoded callback arguments.
 * @returns the callback result.
 */
function shimCallback(
  name: string,
  ...args: unknown[]
): Promise<unknown> {
  return shimCallbackForModule(harness.module, name, ...args);
}

beforeEach(() => {
  harness = createMockModule();
  resetBridgeState();
  (globalThis as Record<string, unknown>).nethackGlobal = {
    globals: {
      flags: {},
      iflags: { wc2_hitpointbar: false, window_inited: false },
      svp: { plname: "" },
    },
    pointers: {},
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("window lifecycle and text", () => {
  it("initializes the window port and allocates typed window IDs", async () => {
    await shimCallback("shim_init_nhwindows", 0, 0);
    const message = await shimCallback("shim_create_nhwindow", NHW_MESSAGE);
    const map = await shimCallback("shim_create_nhwindow", NHW_MAP);

    expect(message).not.toBe(map);
    expect(getWindow(message as number)?.type).toBe(NHW_MESSAGE);
    expect(getWindow(map as number)?.type).toBe(NHW_MAP);
    expect(globalThis.nethackGlobal?.globals?.iflags?.window_inited).toBe(true);
    expect(globalThis.nethackGlobal?.globals?.iflags?.wc2_hitpointbar).toBe(true);
  });

  it("routes putstr by window type and honors ATR_NOHISTORY", async () => {
    const message = await shimCallback("shim_create_nhwindow", NHW_MESSAGE) as number;
    const text = await shimCallback("shim_create_nhwindow", NHW_TEXT) as number;

    await shimCallback("shim_putstr", message, 0, "hello");
    await shimCallback("shim_putstr", message, ATR_NOHISTORY, "temporary");
    await shimCallback("shim_putstr", text, 1, "heading");

    expect(getSnapshot().messages.map((line) => line.text)).toEqual([
      "hello",
      "temporary",
    ]);
    expect(getSnapshot().messageHistory.map((line) => line.text)).toEqual(["hello"]);
    expect(getWindow(text)?.lines[0]).toEqual({ text: "heading", attribute: 1 });
  });

  it("keeps text windows visible until acknowledgement even when blocking is false", async () => {
    const text = await shimCallback("shim_create_nhwindow", NHW_TEXT) as number;
    await shimCallback("shim_putstr", text, 0, "manual");
    const displayed = shimCallback("shim_display_nhwindow", text, false);
    await expectPending(displayed);
    expect(getSnapshot().modal?.kind).toBe("text");

    dismissDisplay();
    await expect(displayed).resolves.toBeUndefined();
    expect(getSnapshot().modal).toBeNull();
  });

  it("flushes non-blocking map windows without requesting acknowledgement", async () => {
    const map = await shimCallback("shim_create_nhwindow", NHW_MAP) as number;

    await expect(
      shimCallback("shim_display_nhwindow", map, false),
    ).resolves.toBeUndefined();

    expect(getSnapshot().modal).toBeNull();
    expect(isWaitingForInput()).toBe(false);
  });

  it("displays putstr-only NHW_MENU windows as text", async () => {
    const menu = await shimCallback("shim_create_nhwindow", NHW_MENU) as number;
    await shimCallback("shim_putstr", menu, 0, "It is written:");
    await shimCallback("shim_putstr", menu, 0, "A dungeon awaits.");

    const blocking = shimCallback("shim_display_nhwindow", menu, true);
    await expectPending(blocking);

    expect(getSnapshot().modal).toEqual({
      kind: "text",
      title: "",
      lines: [
        { text: "It is written:", attribute: 0 },
        { text: "A dungeon awaits.", attribute: 0 },
      ],
    });

    dismissDisplay();
    await expect(blocking).resolves.toBeUndefined();
  });

  it("clears and destroys only the addressed window", async () => {
    const first = await shimCallback("shim_create_nhwindow", NHW_TEXT) as number;
    const second = await shimCallback("shim_create_nhwindow", NHW_TEXT) as number;
    await shimCallback("shim_putstr", first, 0, "first");
    await shimCallback("shim_putstr", second, 0, "second");

    await shimCallback("shim_clear_nhwindow", first);
    expect(getWindow(first)?.lines).toEqual([]);
    expect(getWindow(second)?.lines[0]?.text).toBe("second");

    await shimCallback("shim_destroy_nhwindow", first);
    expect(getWindow(first)).toBeUndefined();
  });
});

describe("player setup and line input", () => {
  it("clears automatic login names before main so askname runs first", () => {
    preparePlayerNamePrompt(harness.module);

    expect(harness.module.ENV).toEqual({
      LOGNAME: "",
      USER: "",
    });
  });

  it("sets a validated identity and required-restore flag before main", () => {
    setStartupIdentity(harness.module, {
      playerName: "Ada",
      role: "Wiz",
      race: "Hum",
      gender: "Fem",
      alignment: "Neu",
    });
    setRestoreRequired(harness.module, true);

    expect(harness.module.ccall).toHaveBeenCalledWith(
      "shim_graphics_set_player_name",
      null,
      ["string"],
      ["Ada"],
    );
    expect(harness.module.ccall).toHaveBeenCalledWith(
      "shim_graphics_set_restore_required",
      null,
      ["number"],
      [1],
    );
  });

  it("delegates role selection to genl_player_setup", async () => {
    await expect(shimCallback("shim_player_selection_or_tty")).resolves.toBe(true);
  });

  it("waits for a player name and caps it to PL_NSIZ minus one UTF-8 bytes", async () => {
    const promise = shimCallback("shim_askname");
    await expectPending(promise);
    expect(getSnapshot().inputRequest).toEqual({
      kind: "line",
      purpose: "name",
      query: "Who are you?",
    });

    submitLine("é".repeat(40));
    await expect(promise).resolves.toBeUndefined();

    const name = globalThis.nethackGlobal?.globals?.svp?.plname ?? "";
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(31);
  });

  it("publishes known save names with askname and normalizes input identically", async () => {
    setKnownSaveNames(["Ada", "Bob"]);
    const promise = shimCallback("shim_askname");
    await expectPending(promise);

    expect(getSnapshot().inputRequest).toEqual({
      kind: "line",
      purpose: "name",
      query: "Who are you?",
      existingSaveNames: ["Ada", "Bob"],
    });
    expect(normalizePlayerNameInput("  Ada  ")).toBe("Ada");
    expect(
      new TextEncoder().encode(normalizePlayerNameInput("é".repeat(40))).length,
    ).toBeLessThanOrEqual(31);

    submitLine("Ada");
    await promise;
  });

  it("writes getlin input to its 256-byte buffer and writes ESC on cancel", async () => {
    const input = shimCallback("shim_getlin", "Name this item:", 0x400);
    await expectPending(input);
    submitLine("x".repeat(300));
    await expect(input).resolves.toBeUndefined();

    expect(harness.module.stringToUTF8).toHaveBeenCalledWith(
      "x".repeat(300),
      0x400,
      256,
    );
    expect(harness.module.UTF8ToString(0x400)).toHaveLength(255);

    const cancelled = shimCallback("shim_getlin", "Cancel:", 0x600);
    submitLine(null);
    await cancelled;
    expect(harness.memory[0x600]).toBe(27);
    expect(harness.memory[0x601]).toBe(0);
  });
});

describe("map and status decoding", () => {
  it("decodes foreground and background glyph_info using the WASM32 layout", async () => {
    const foreground = 0x1000;
    const background = 0x1100;
    for (const [ptr, values] of [
      [foreground, [10, 64, 3, 1, 15, 7, 0x112233, 240, 9]],
      [background, [20, 46, 0, 0, 7, 8, 0, 0, 3]],
    ] as const) {
      harness.writeI32(ptr, values[0]);
      harness.writeI32(ptr + 4, values[1]);
      harness.writeI32(ptr + 8, values[2]);
      harness.writeI32(ptr + 12, values[3]);
      harness.writeI32(ptr + 16, values[4]);
      harness.writeI32(ptr + 20, values[5]);
      harness.writeI32(ptr + 24, values[6]);
      harness.writeI16(ptr + 28, values[7]);
      harness.writeI16(ptr + 30, values[8]);
    }

    await shimCallback("shim_print_glyph", 1, 12, 6, foreground, background);
    await shimCallback("shim_mark_synch");

    expect(getSnapshot().map[6][12]).toEqual({
      foreground: {
        glyph: 10,
        ttyChar: 64,
        frameColor: 3,
        glyphFlags: 1,
        color: 15,
        symbolIndex: 7,
        customColor: 0x112233,
        color256: 240,
        tileIndex: 9,
      },
      background: {
        glyph: 20,
        ttyChar: 46,
        frameColor: 0,
        glyphFlags: 0,
        color: 7,
        symbolIndex: 8,
        customColor: 0,
        color256: 0,
        tileIndex: 3,
      },
    });
  });

  it("ignores map column zero and tracks the cursor", async () => {
    harness.writeI32(0x1004, 35);
    await shimCallback("shim_print_glyph", 1, 0, 0, 0x1000, 0);
    await shimCallback("shim_curs", 1, 79, 20);
    await shimCallback("shim_mark_synch");

    expect(getSnapshot().map[0][0].foreground).toBeNull();
    expect(getSnapshot().cursor).toEqual({ x: 79, y: 20, visible: true });
  });

  it("dereferences normal and condition status values and commits on BL_FLUSH", async () => {
    harness.writeString(0x2000, "Ada the Tourist");
    harness.writeI32(0x2100, 0x00400002);
    for (let index = 0; index < 24; index += 1) {
      harness.writeI32(0x2200 + index * 4, index + 1);
    }

    await shimCallback("shim_status_update", 0, 0x2000, 1, 80, 0x0104, 0);
    await shimCallback("shim_status_update", BL_CONDITION, 0x2100, 0, 0, 0, 0x2200);
    expect(getSnapshot().status).toEqual({});

    await shimCallback("shim_status_update", BL_FLUSH, 0, 0, 0, 0, 0);

    expect(getSnapshot().status[0]).toMatchObject({
      text: "Ada the Tourist",
      change: 1,
      percent: 80,
      color: 4,
      attributes: 1,
    });
    expect(getSnapshot().status[BL_CONDITION]).toMatchObject({
      conditionMask: 0x00400002,
      conditionColors: Array.from({ length: 24 }, (_, index) => index + 1),
    });

    harness.writeString(0x2400, "12");
    await shimCallback("shim_status_update", 1, 0x2400, 0, 0, 0, 0);
    await shimCallback("shim_status_update", BL_RESET, 0, 0, 0, 0, 0);
    expect(getSnapshot().status[0]?.text).toBe("Ada the Tourist");
    expect(getSnapshot().status[1]?.text).toBe(" St:12");
  });

  it("decodes the encoded gold glyph in BL_GOLD text", async () => {
    harness.writeString(0x2300, "\\GABCD1234:514");

    await shimCallback("shim_status_update", BL_GOLD, 0x2300, 0, 0, 0, 0);
    await shimCallback("shim_status_update", BL_FLUSH, 0, 0, 0, 0, 0);

    expect(getSnapshot().status[BL_GOLD]?.text).toBe(" $:514");
  });
});

describe("key, position, and prompt input", () => {
  it("keeps nhgetch pending until a non-zero byte is supplied", async () => {
    const promise = shimCallback("shim_nhgetch");
    expect(isWaitingForInput()).toBe(true);
    sendKey(0);
    await expectPending(promise);

    sendKey(0xe1);
    await expect(promise).resolves.toBe(0xe1);
    expect(isWaitingForInput()).toBe(false);
  });

  it("returns keyboard input from nh_poskey without touching output pointers", async () => {
    harness.writeI16(0x300, -1);
    harness.writeI16(0x302, -1);
    harness.writeI32(0x304, -1);
    const promise = shimCallback("shim_nh_poskey", 0x300, 0x302, 0x304);

    sendKey(27);

    await expect(promise).resolves.toBe(27);
    expect(harness.readI16(0x300)).toBe(-1);
    expect(harness.readI16(0x302)).toBe(-1);
    expect(harness.readI32(0x304)).toBe(-1);
  });

  it("reports command input only while the matching key request is pending", async () => {
    const command = shimCallback(
      "shim_nh_poskey",
      0x300,
      0x302,
      0x304,
      1,
    );
    expect(getSnapshot().commandInput).toBe(true);

    sendKey(27);
    await expect(command).resolves.toBe(27);
    expect(getSnapshot().commandInput).toBe(false);

    const direction = shimCallback(
      "shim_nh_poskey",
      0x300,
      0x302,
      0x304,
      3,
    );
    expect(getSnapshot().commandInput).toBe(false);
    sendKey("h".charCodeAt(0));
    await expect(direction).resolves.toBe("h".charCodeAt(0));
  });

  it("buffers a short burst typed before the core requests its next keys", async () => {
    const first = shimCallback("shim_nhgetch");
    sendKey("l".charCodeAt(0));
    await expect(first).resolves.toBe("l".charCodeAt(0));

    sendKey("h".charCodeAt(0));
    sendKey("j".charCodeAt(0));

    await expect(shimCallback("shim_nhgetch")).resolves.toBe(
      "h".charCodeAt(0),
    );
    await expect(shimCallback("shim_nhgetch")).resolves.toBe(
      "j".charCodeAt(0),
    );
  });

  it("does not queue keys before the core has accepted its first game input", async () => {
    sendKey("x".charCodeAt(0));
    const requested = shimCallback("shim_nhgetch");
    await expectPending(requested);

    sendKey("y".charCodeAt(0));

    await expect(requested).resolves.toBe("y".charCodeAt(0));
  });

  it.each([
    [1, 0, 0],
    [79, 20, 2],
  ])("returns mouse position (%d,%d) and modifier %d from nh_poskey", async (x, y, mod) => {
    const promise = shimCallback("shim_nh_poskey", 0x300, 0x302, 0x304);

    sendPosition(x, y, mod === 2 ? 2 : 1);

    await expect(promise).resolves.toBe(0);
    expect(harness.readI16(0x300)).toBe(x);
    expect(harness.readI16(0x302)).toBe(y);
    expect(harness.readI32(0x304)).toBe(mod === 2 ? 2 : 1);
  });

  it("applies NetHack yn_function default, case, invalid, and escape rules", async () => {
    const defaulted = shimCallback("shim_yn_function", "Continue?", "ynq", 110);
    sendKey(10);
    await expect(defaulted).resolves.toBe(110);

    const accepted = shimCallback("shim_yn_function", "Continue?", "ynq", 0);
    sendKey(89);
    await expect(accepted).resolves.toBe(121);

    const invalid = shimCallback("shim_yn_function", "Continue?", "ynq", 0);
    sendKey(120);
    await expectPending(invalid);
    sendKey(27);
    await expect(invalid).resolves.toBe(113);
  });

  it("skips only the save confirmation and its next blocking message", async () => {
    const message = await shimCallback(
      "shim_create_nhwindow",
      NHW_MESSAGE,
    ) as number;
    const map = await shimCallback("shim_create_nhwindow", NHW_MAP) as number;
    const command = shimCallback(
      "shim_nh_poskey",
      0x300,
      0x302,
      0x304,
      1,
    );

    requestSaveAndExit();

    await expect(command).resolves.toBe("S".charCodeAt(0));
    await expect(
      shimCallback("shim_yn_function", "Really save?", "yn", 110),
    ).resolves.toBe("y".charCodeAt(0));
    await expect(
      shimCallback("shim_display_nhwindow", map, false),
    ).resolves.toBeUndefined();
    await expect(
      shimCallback("shim_display_nhwindow", message, true),
    ).resolves.toBeUndefined();
    expect(getSnapshot().inputRequest).toBeNull();

    const laterDisplay = shimCallback("shim_display_nhwindow", message, true);
    await expectPending(laterDisplay);
    expect(getSnapshot().inputRequest).toMatchObject({
      kind: "message",
      message: "--More--",
    });
    sendKey(" ".charCodeAt(0));
    await expect(laterDisplay).resolves.toBeUndefined();
  });

  it("clears save auto-confirmation when the next yn prompt does not match", async () => {
    const command = shimCallback(
      "shim_nh_poskey",
      0x300,
      0x302,
      0x304,
      1,
    );
    requestSaveAndExit();
    await expect(command).resolves.toBe("S".charCodeAt(0));

    const unrelated = shimCallback(
      "shim_yn_function",
      "Really quit?",
      "yn",
      110,
    );
    await expectPending(unrelated);
    sendKey("n".charCodeAt(0));
    await expect(unrelated).resolves.toBe("n".charCodeAt(0));

    const laterSave = shimCallback(
      "shim_yn_function",
      "Really save?",
      "yn",
      110,
    );
    await expectPending(laterSave);
    sendKey("n".charCodeAt(0));
    await expect(laterSave).resolves.toBe("n".charCodeAt(0));
  });

  it("does not arm save auto-confirmation outside command input", async () => {
    const direction = shimCallback(
      "shim_nh_poskey",
      0x300,
      0x302,
      0x304,
      3,
    );

    requestSaveAndExit();
    await expectPending(direction);
    sendKey("h".charCodeAt(0));
    await expect(direction).resolves.toBe("h".charCodeAt(0));

    const savePrompt = shimCallback(
      "shim_yn_function",
      "Really save?",
      "yn",
      110,
    );
    await expectPending(savePrompt);
    sendKey("n".charCodeAt(0));
    await expect(savePrompt).resolves.toBe("n".charCodeAt(0));
  });

  it("returns q unchanged for the unrestricted role-selection prompt", async () => {
    const requested = shimCallback(
      "shim_yn_function",
      "Shall I pick character's race, role, gender and alignment for you? [ynaq]",
      "",
      0,
    );

    sendKey("q".charCodeAt(0));

    await expect(requested).resolves.toBe("q".charCodeAt(0));
  });

  it("does not return a count marker when yn_number is unavailable", async () => {
    const counted = shimCallback("shim_yn_function", "How many?", "yn#", 110);

    sendKey("4".charCodeAt(0));
    await expectPending(counted);
    sendKey("#".charCodeAt(0));
    await expectPending(counted);
    sendKey("n".charCodeAt(0));

    await expect(counted).resolves.toBe("n".charCodeAt(0));
  });

  it("keeps an unrestricted yn prompt pending for non-ASCII Meta bytes", async () => {
    const direction = shimCallback("shim_yn_function", "In what direction?", "", 0);

    sendKey(0xe8);
    await expectPending(direction);
    sendKey("h".charCodeAt(0));

    await expect(direction).resolves.toBe("h".charCodeAt(0));
  });

  it("stores number-pad mode from shim_number_pad", async () => {
    await shimCallback("shim_number_pad", 1);
    expect(getSnapshot().numberPad).toBe(true);
    await shimCallback("shim_number_pad", 0);
    expect(getSnapshot().numberPad).toBe(false);
  });
});

describe("runtime settings synchronization", () => {
  it("publishes snapshots and returns one queued update at a command boundary", async () => {
    const initial = createDefaultProfile().nethack;
    const initialPayload = encodeRuntimeSettings(initial, false);

    await expect(
      shimCallback("shim_settings_sync", initialPayload),
    ).resolves.toBe(0);
    expect(getSnapshot().runtimeSettings).toMatchObject({
      autopickup: true,
      numberPad: 0,
      showTime: false,
    });
    expect(getSnapshot().runtimeSettingsStatus).toBe("idle");

    const requested = createDefaultProfile().nethack;
    requested.autopickup = false;
    requested.numberPad = -1;
    requested.showTime = true;
    queueRuntimeSettings(requested);
    expect(getSnapshot().runtimeSettingsStatus).toBe("pending");

    await expect(
      shimCallback("shim_settings_sync", initialPayload),
    ).resolves.toBe(encodeRuntimeSettings(requested, true));
    expect(getSnapshot().runtimeSettingsStatus).toBe("pending");

    await shimCallback(
      "shim_settings_result",
      1,
      encodeRuntimeSettings(requested, false),
    );
    expect(getSnapshot().runtimeSettings).toEqual({
      autopickup: false,
      pickupTypes: { mode: "all" },
      numberPad: -1,
      safePet: true,
      sortpack: true,
      showExperience: false,
      showTime: true,
    });
    expect(getSnapshot().runtimeSettingsStatus).toBe("applied");

    await shimCallback(
      "shim_settings_sync",
      encodeRuntimeSettings(requested, false),
    );
    expect(getSnapshot().runtimeSettingsStatus).toBe("idle");
  });

  it("turns malformed snapshots and rejected updates into runtime errors", async () => {
    await expect(shimCallback("shim_settings_sync", 0)).resolves.toBe(0);
    expect(getSnapshot()).toMatchObject({
      phase: "error",
      error: expect.stringContaining("shim_settings_sync"),
    });

    resetBridgeState();
    const settings = createDefaultProfile().nethack;
    queueRuntimeSettings(settings);
    await shimCallback(
      "shim_settings_sync",
      encodeRuntimeSettings(settings, false),
    );
    await shimCallback(
      "shim_settings_result",
      0,
      encodeRuntimeSettings(settings, false),
    );
    expect(getSnapshot()).toMatchObject({
      phase: "error",
      error: expect.stringContaining("rejected"),
    });
  });
});

describe("menus", () => {
  it("stores the identifier already decoded by winshim's integer format", async () => {
    const menu = await shimCallback("shim_create_nhwindow", NHW_MENU) as number;

    await shimCallback("shim_start_menu", menu, 0);
    await shimCallback("shim_add_menu", menu, 0, 0, 0, 0, 1, 7, "Heading", 0);
    await shimCallback("shim_add_menu", menu, 0, 7, 97, 0, 0, 2, "a - item", 1);
    await shimCallback("shim_end_menu", menu, "Choose:");

    expect(getWindow(menu)?.menuItems[0]?.identifier).toBeNull();
    expect(getWindow(menu)?.menuItems[1]?.identifier).toBe(7);
  });

  it("writes a 16-byte menu_item array and output pointer for selections", async () => {
    const menu = await shimCallback("shim_create_nhwindow", NHW_MENU) as number;
    await shimCallback("shim_start_menu", menu, 0);
    await shimCallback("shim_add_menu", menu, 0, 7, 97, 0, 0, 2, "a - item", 0);
    await shimCallback("shim_end_menu", menu, "Choose:");
    const promise = shimCallback("shim_select_menu", menu, PICK_ANY, 0x200);

    await expectPending(promise);
    submitMenuSelection([{ itemIndex: 0, count: 3 }]);

    await expect(promise).resolves.toBe(1);
    const resultPtr = harness.readI32(0x200);
    expect(Array.from(harness.memory.slice(resultPtr, resultPtr + 8))).toEqual([
      7, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(harness.readI32(resultPtr + 8)).toBe(3);
    expect(harness.readI32(resultPtr + 12)).toBe(0);
  });

  it("distinguishes cancel, empty confirmation, and PICK_NONE display", async () => {
    const menu = await shimCallback("shim_create_nhwindow", NHW_MENU) as number;
    await shimCallback("shim_start_menu", menu, 0);
    await shimCallback("shim_end_menu", menu, "");

    const cancelled = shimCallback("shim_select_menu", menu, PICK_ONE, 0x200);
    submitMenuSelection(null);
    await expect(cancelled).resolves.toBe(-1);
    expect(harness.readI32(0x200)).toBe(0);

    const empty = shimCallback("shim_select_menu", menu, PICK_ANY, 0x200);
    submitMenuSelection([]);
    await expect(empty).resolves.toBe(0);

    const display = shimCallback("shim_select_menu", menu, PICK_NONE, 0x200);
    await expectPending(display);
    dismissDisplay();
    await expect(display).resolves.toBe(0);
  });

  it("does not block or open a modal for permanent inventory updates", async () => {
    const menu = await shimCallback("shim_create_nhwindow", NHW_MENU) as number;
    await shimCallback("shim_start_menu", menu, MENU_BEHAVE_PERMINV);
    await shimCallback("shim_end_menu", menu, "");

    await expect(shimCallback("shim_select_menu", menu, PICK_NONE, 0x200)).resolves.toBe(0);
    expect(getSnapshot().modal).toBeNull();
    expect(getSnapshot().inventoryWindowId).toBe(menu);
  });

  it("implements message_menu PICK_NONE and PICK_ONE return contracts", async () => {
    await expect(
      shimCallback("shim_message_menu", 0x12345661, PICK_NONE, "context"),
    ).resolves.toBe(0);
    expect(getSnapshot().messages.at(-1)?.text).toBe("context");

    const dismissed = shimCallback("shim_message_menu", 0x12345661, PICK_ONE, "choose");
    sendKey(98);
    await expect(dismissed).resolves.toBe(0);

    const accepted = shimCallback("shim_message_menu", 0x12345661, PICK_ONE, "choose");
    sendKey(97);
    await expect(accepted).resolves.toBe(97);
  });
});

describe("files, history, extended commands, and lifecycle", () => {
  it("loads display_file content from the embedded nhdat DLB archive", async () => {
    harness.files.set(
      "/nhdat",
      createDlbArchive({ help: "help line 1\nhelp line 2\n" }),
    );
    const promise = shimCallback("shim_display_file", "help", true);
    await expectPending(promise);
    expect(harness.module.FS.readFile).toHaveBeenCalledWith("/nhdat");
    expect(getSnapshot().modal).toMatchObject({
      kind: "text",
      title: "help",
    });

    dismissDisplay();
    await expect(promise).resolves.toBeUndefined();
  });

  it("restores old history before current-session messages and ignores the NULL terminator", async () => {
    const message = await shimCallback("shim_create_nhwindow", NHW_MESSAGE) as number;
    await shimCallback("shim_putstr", message, 0, "current");
    await shimCallback("shim_putmsghistory", "older", true);
    await shimCallback("shim_putmsghistory", "newer", true);
    await shimCallback("shim_putmsghistory", "", true);

    expect(getSnapshot().messages.map((line) => line.text)).toEqual(["current"]);
    expect(getSnapshot().messageHistory.map((line) => line.text)).toEqual([
      "older",
      "newer",
      "current",
    ]);

    const history = shimCallback("shim_doprev_message", undefined);
    await expectPending(history);
    expect(getSnapshot().modal).toMatchObject({ kind: "history" });
    dismissDisplay();
    await expect(history).resolves.toBe(0);

    await expect(shimCallback("shim_getmsghistory", true)).resolves.toBe("");
  });

  it("adds non-restoring putmsghistory text to recall without displaying it", async () => {
    await shimCallback("shim_putmsghistory", "quest summary", false);

    expect(getSnapshot().messages).toEqual([]);
    expect(getSnapshot().messageHistory.map((line) => line.text)).toEqual([
      "quest summary",
    ]);
  });

  it("matches the shim fingerprint before reading save identity", async () => {
    const fingerprint = Uint8Array.of(104, 0);
    const save = new Uint8Array(fingerprint.length + 4 + 49);
    save.set(fingerprint);
    new DataView(save.buffer).setInt32(fingerprint.length, 49, true);
    save.set(
      new TextEncoder().encode("Ada\0Wiz-Hum-Fem-Neu"),
      fingerprint.length + 4,
    );
    save[save.length - 1] = "-".charCodeAt(0);
    harness.files.set("/save/0Ada", save);
    vi.mocked(harness.module.ccall).mockImplementation((
      name,
      _returnType,
      _argumentTypes,
      arguments_,
    ) => {
      if (name !== "shim_graphics_get_save_fingerprint") return undefined;
      harness.memory.set(fingerprint, arguments_[0] as number);
      return fingerprint.length;
    });

    await expect(validateSaveMetadata(
      harness.module as never,
      "/save/0Ada",
    )).resolves.toEqual({
      status: "ready",
      identity: {
        playerName: "Ada",
        role: "Wiz",
        race: "Hum",
        gender: "Fem",
        alignment: "Neu",
      },
    });
    expect(harness.module.ccall).toHaveBeenCalledWith(
      "shim_graphics_get_save_fingerprint",
      "number",
      ["number", "number"],
      [expect.any(Number), 256],
    );
  });

  it("validates uploaded bytes without trusting their external file name", async () => {
    const fingerprint = Uint8Array.of(104, 0);
    const save = new Uint8Array(fingerprint.length + 4 + 49);
    save.set(fingerprint);
    new DataView(save.buffer).setInt32(fingerprint.length, 49, true);
    save.set(
      new TextEncoder().encode("Ada\0Wiz-Hum-Fem-Neu"),
      fingerprint.length + 4,
    );
    save[save.length - 1] = "-".charCodeAt(0);
    vi.mocked(harness.module.ccall).mockImplementation((
      name,
      _returnType,
      _argumentTypes,
      arguments_,
    ) => {
      if (name !== "shim_graphics_get_save_fingerprint") return undefined;
      harness.memory.set(fingerprint, arguments_[0] as number);
      return fingerprint.length;
    });

    await expect(validateSaveBytes(
      harness.module as never,
      save,
    )).resolves.toEqual({
      status: "ready",
      identity: {
        playerName: "Ada",
        role: "Wiz",
        race: "Hum",
        gender: "Fem",
        alignment: "Neu",
      },
    });
    expect(harness.module.FS.readFile).not.toHaveBeenCalled();
  });

  it("parses the WASM extcmdlist and returns the selected source index", async () => {
    const listPtr = 0x1000;
    harness.writeString(0x1800, "adjust");
    harness.writeString(0x1820, "adjust inventory letters");
    harness.memory[listPtr] = 0xe1;
    harness.writeI32(listPtr + 4, 0x1800);
    harness.writeI32(listPtr + 8, 0x1820);
    harness.writeI32(listPtr + 16, 0x0002);

    harness.writeString(0x1880, "shell");
    harness.writeString(0x18a0, "escape to a shell");
    harness.writeI32(listPtr + 24 + 4, 0x1880);
    harness.writeI32(listPtr + 24 + 8, 0x18a0);
    harness.writeI32(listPtr + 24 + 16, 0x0012);

    harness.writeI32(listPtr + 48 + 4, 0);
    if (globalThis.nethackGlobal?.pointers) {
      globalThis.nethackGlobal.pointers.extcmdlist = listPtr;
    }

    const promise = shimCallback("shim_get_ext_cmd", undefined);
    await expectPending(promise);
    expect(getSnapshot().modal).toEqual({
      kind: "extcmd",
      commands: [{
        sourceIndex: 0,
        name: "adjust",
        description: "adjust inventory letters",
      }],
    });

    submitExtendedCommand(0);
    await expect(promise).resolves.toBe(0);
  });

  it("delays output for 50ms with an observable bell and exit state", async () => {
    vi.useFakeTimers();
    await shimCallback("shim_nhbell");
    expect(getSnapshot().bellCount).toBe(1);

    const delay = shimCallback("shim_delay_output");
    await vi.advanceTimersByTimeAsync(49);
    await expectPending(delay);
    await vi.advanceTimersByTimeAsync(1);
    await expect(delay).resolves.toBeUndefined();

    await shimCallback("shim_exit_nhwindows", "goodbye");
    expect(getSnapshot().phase).toBe("exited");
    expect(getSnapshot().exitReason).toBe("goodbye");
  });

  it.each([
    "shim_get_nh_event",
    "shim_suspend_nhwindows",
    "shim_resume_nhwindows",
    "shim_mark_synch",
    "shim_wait_synch",
    "shim_cliparound",
  ])("handles the contract-valid no-op %s", async (name) => {
    await expect(shimCallback(name)).resolves.toBeUndefined();
  });
});
