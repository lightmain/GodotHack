import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATR_NOHISTORY,
  COLNO,
  MENU_BEHAVE_PERMINV,
  MENU_BEHAVE_STANDARD,
  NHW_MAP,
  NHW_MENU,
  NHW_MESSAGE,
  NHW_TEXT,
  ROWNO,
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
  getSnapshot,
  getWindow,
  resetGameState,
  resetStatus,
  setCursor,
  setInputRequest,
  setMapCell,
  setNumberPad,
  setInventoryWindow,
  setRuntimePhase,
  setStatusValue,
  showMenu,
  showText,
  subscribe,
} from "./game-state";

beforeEach(() => {
  resetGameState();
});

describe("game state windows", () => {
  it("creates unique windows and preserves their declared types", () => {
    const message = createWindow(NHW_MESSAGE);
    const map = createWindow(NHW_MAP);

    expect(message).not.toBe(map);
    expect(getWindow(message)?.type).toBe(NHW_MESSAGE);
    expect(getWindow(map)?.type).toBe(NHW_MAP);
  });

  it("routes message text to display messages and persistent history", () => {
    const message = createWindow(NHW_MESSAGE);

    appendWindowText(message, 0, "first");
    appendWindowText(message, ATR_NOHISTORY, "transient");

    expect(getSnapshot().messages.map((line) => line.text)).toEqual([
      "first",
      "transient",
    ]);
    expect(getSnapshot().messageHistory.map((line) => line.text)).toEqual([
      "first",
    ]);
  });

  it("stores text-window lines and clears or destroys the target window", () => {
    const text = createWindow(NHW_TEXT);
    appendWindowText(text, 1, "heading");
    appendWindowText(text, 0, "body");
    expect(getWindow(text)?.lines.map((line) => line.text)).toEqual([
      "heading",
      "body",
    ]);

    clearWindow(text);
    expect(getWindow(text)?.lines).toEqual([]);

    destroyWindow(text);
    expect(getWindow(text)).toBeUndefined();
  });

  it("does not publish while an undisplayed text window is being assembled", () => {
    const text = createWindow(NHW_TEXT);
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    appendWindowText(text, 1, "heading");
    appendWindowText(text, 0, "body");
    clearWindow(text);
    destroyWindow(text);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("game state map and cursor", () => {
  it("uses the official 80 by 21 map dimensions", () => {
    expect(getSnapshot().map).toHaveLength(ROWNO);
    expect(getSnapshot().map[0]).toHaveLength(COLNO);
  });

  it("buffers glyph changes until a display flush", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    setMapCell(10, 4, {
      glyph: 12,
      ttyChar: 64,
      frameColor: 0,
      glyphFlags: 1,
      color: 15,
      symbolIndex: 0,
      customColor: 0,
      color256: 0,
      tileIndex: 0,
    }, null);
    expect(listener).not.toHaveBeenCalled();

    flushDisplay();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSnapshot().map[4][10].foreground?.ttyChar).toBe(64);

    unsubscribe();
  });

  it("replaces only dirty map rows when buffered glyphs are flushed", () => {
    const before = getSnapshot().map;
    const changedRow = before[4];
    const untouchedRow = before[5];

    setMapCell(10, 4, {
      glyph: 12,
      ttyChar: 64,
      frameColor: 0,
      glyphFlags: 1,
      color: 15,
      symbolIndex: 0,
      customColor: 0,
      color256: 0,
      tileIndex: 0,
    }, null);

    expect(before[4][10].foreground).toBeNull();
    flushDisplay();

    const after = getSnapshot().map;
    expect(after).not.toBe(before);
    expect(after[4]).not.toBe(changedRow);
    expect(after[5]).toBe(untouchedRow);
    expect(after[4][10].foreground?.ttyChar).toBe(64);
  });

  it("does not notify subscribers for an empty display flush", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    flushDisplay();

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("ignores column zero and out-of-bounds glyph coordinates", () => {
    const glyph = {
      glyph: 1,
      ttyChar: 35,
      frameColor: 0,
      glyphFlags: 0,
      color: 7,
      symbolIndex: 0,
      customColor: 0,
      color256: 0,
      tileIndex: 0,
    };

    setMapCell(0, 0, glyph, null);
    setMapCell(COLNO, 0, glyph, null);
    setMapCell(1, ROWNO, glyph, null);
    flushDisplay();

    expect(getSnapshot().map.flat().every((cell) => cell.foreground === null)).toBe(true);
  });

  it("tracks the cursor independently from map cells", () => {
    const map = createWindow(NHW_MAP);
    setCursor(map, 20, 8);
    expect(getSnapshot().cursor).toEqual({ x: 20, y: 8, visible: true });
  });

  it("does not publish an unchanged cursor position", () => {
    const map = createWindow(NHW_MAP);
    const listener = vi.fn();
    setCursor(map, 20, 8);
    const unsubscribe = subscribe(listener);

    setCursor(map, 20, 8);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("game state menus and prompts", () => {
  it("preserves menu behavior and all menu item metadata", () => {
    const menu = createWindow(NHW_MENU);

    beginMenu(menu, MENU_BEHAVE_PERMINV);
    addMenuItem(menu, {
      glyph: null,
      identifier: 7,
      accelerator: 97,
      groupAccelerator: 0,
      attribute: 1,
      color: 2,
      text: "a - a mace",
      itemFlags: 1,
    });

    expect(getWindow(menu)?.menuBehavior).toBe(MENU_BEHAVE_PERMINV);
    expect(getWindow(menu)?.menuItems[0]).toEqual({
      glyph: null,
      identifier: 7,
      accelerator: 97,
      groupAccelerator: 0,
      attribute: 1,
      color: 2,
      text: "a - a mace",
      itemFlags: 1,
    });

    beginMenu(menu, MENU_BEHAVE_STANDARD);
    expect(getWindow(menu)?.menuItems).toEqual([]);
    expect(getWindow(menu)?.menuBehavior).toBe(MENU_BEHAVE_STANDARD);
  });

  it("publishes and clears modal and input state", () => {
    const menu = createWindow(NHW_MENU);
    beginMenu(menu, MENU_BEHAVE_STANDARD);
    showMenu(menu, 1);
    expect(getSnapshot().modal).toEqual({
      kind: "menu",
      windowId: menu,
      how: 1,
    });

    showText("Help", [{ text: "line", attribute: 0 }]);
    expect(getSnapshot().modal?.kind).toBe("text");

    setInputRequest({ kind: "yn", query: "Really?", choices: "yn", defaultCode: 110 });
    expect(getSnapshot().inputRequest?.kind).toBe("yn");

    clearModal();
    setInputRequest(null);
    expect(getSnapshot().modal).toBeNull();
    expect(getSnapshot().inputRequest).toBeNull();
  });

  it("commits immutable permanent inventory snapshots with monotonic revisions", () => {
    const inventory = createWindow(NHW_MENU);
    const firstItem = {
      glyph: null,
      identifier: 41,
      accelerator: "a".charCodeAt(0),
      groupAccelerator: 0,
      attribute: 1,
      color: 2,
      text: "a - a mace",
      itemFlags: 1,
    };

    beginMenu(inventory, MENU_BEHAVE_PERMINV);
    addMenuItem(inventory, firstItem);
    endMenu(inventory, "Inventory");
    expect(getSnapshot().permanentInventory).toBeNull();

    setInventoryWindow(inventory);
    const first = getSnapshot().permanentInventory;
    expect(first).toEqual({
      revision: 1,
      windowId: inventory,
      prompt: "Inventory",
      items: [firstItem],
    });

    beginMenu(inventory, MENU_BEHAVE_PERMINV);
    addMenuItem(inventory, { ...firstItem, identifier: 99, accelerator: 98, text: "b - a wand" });
    expect(getSnapshot().permanentInventory).toBe(first);
    expect(first?.items[0]).toEqual(firstItem);

    endMenu(inventory, "Carrying");
    setInventoryWindow(inventory);
    expect(getSnapshot().permanentInventory).toEqual({
      revision: 2,
      windowId: inventory,
      prompt: "Carrying",
      items: [{ ...firstItem, identifier: 99, accelerator: 98, text: "b - a wand" }],
    });
  });

  it("keeps ordinary menus isolated and clears permanent inventory on destroy/reset", () => {
    const inventory = createWindow(NHW_MENU);
    beginMenu(inventory, MENU_BEHAVE_PERMINV);
    endMenu(inventory, "Inventory");
    setInventoryWindow(inventory);
    const committed = getSnapshot().permanentInventory;

    const ordinary = createWindow(NHW_MENU);
    beginMenu(ordinary, MENU_BEHAVE_STANDARD);
    endMenu(ordinary, "Choose");
    showMenu(ordinary, 1);
    expect(getSnapshot().permanentInventory).toBe(committed);

    destroyWindow(inventory);
    expect(getSnapshot().permanentInventory).toBeNull();

    beginMenu(ordinary, MENU_BEHAVE_PERMINV);
    endMenu(ordinary, "New session item");
    setInventoryWindow(ordinary);
    resetGameState();
    expect(getSnapshot().permanentInventory).toBeNull();
  });
});

describe("game state status and runtime flags", () => {
  it("commits status fields atomically on BL_FLUSH", () => {
    setStatusValue(0, {
      text: "Ada the Tourist",
      change: 0,
      percent: 0,
      color: 7,
      attributes: 0,
      conditionColors: [],
    });
    expect(getSnapshot().status).toEqual({});

    flushStatus();
    expect(getSnapshot().status[0]?.text).toBe("Ada the Tourist");

    resetStatus();
    expect(getSnapshot().status).toEqual({});
  });

  it("tracks phase and number-pad mode", () => {
    setRuntimePhase("running");
    setNumberPad(true);

    expect(getSnapshot().phase).toBe("running");
    expect(getSnapshot().numberPad).toBe(true);
  });
});
