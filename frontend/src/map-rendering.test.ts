import { describe, expect, it } from "vitest";
import type { GlyphInfo, MapCell } from "./game-state";
import {
  buildMapRuns,
  mapFollowOffset,
  mapPositionFromPoint,
} from "./map-rendering";

/**
 * Create a map cell with the display fields needed by the row renderer.
 * @param character - visible ASCII character.
 * @param color - NetHack color index.
 * @param glyphFlags - glyph metadata flags.
 * @returns one map cell fixture.
 */
function cell(
  character: string,
  color = 7,
  glyphFlags = 0,
): MapCell {
  const foreground: GlyphInfo = {
    glyph: character.charCodeAt(0),
    ttyChar: character.charCodeAt(0),
    frameColor: 0,
    glyphFlags,
    color,
    symbolIndex: 0,
    customColor: 0,
    color256: 0,
    tileIndex: 0,
  };
  return { foreground, background: null };
}

describe("map row rendering", () => {
  it("groups adjacent cells with equal visible styles into text runs", () => {
    const runs = buildMapRuns([
      cell(".", 7),
      cell(".", 7),
      cell("@", 15),
      cell("d", 3, 0x10),
      cell(" ", 7),
    ], -1);

    expect(runs).toEqual([
      { start: 0, text: "..", color: 7, pet: false, cursor: false },
      { start: 2, text: "@", color: 15, pet: false, cursor: false },
      { start: 3, text: "d", color: 3, pet: true, cursor: false },
      { start: 4, text: " ", color: 7, pet: false, cursor: false },
    ]);
    expect(runs.map((run) => run.text).join("")).toBe("..@d ");
  });

  it("splits the cursor cell into its own run", () => {
    const runs = buildMapRuns([
      cell(".", 7),
      cell(".", 7),
      cell(".", 7),
    ], 1);

    expect(runs).toEqual([
      { start: 0, text: ".", color: 7, pet: false, cursor: false },
      { start: 1, text: ".", color: 7, pet: false, cursor: true },
      { start: 2, text: ".", color: 7, pet: false, cursor: false },
    ]);
  });

  it("converts pointer coordinates to the official map coordinate", () => {
    expect(mapPositionFromPoint(250, 105, {
      left: 10,
      top: 0,
      width: 480,
      height: 210,
    })).toEqual({ x: 40, y: 10 });
    expect(mapPositionFromPoint(10, 5, {
      left: 10,
      top: 0,
      width: 480,
      height: 210,
    })).toBeNull();
  });

  it("centers the followed map position and clamps at map edges", () => {
    const dimensions = {
      scrollWidth: 800,
      scrollHeight: 420,
      clientWidth: 400,
      clientHeight: 210,
    };

    expect(mapFollowOffset(40, 10, dimensions)).toEqual({
      left: 205,
      top: 105,
    });
    expect(mapFollowOffset(1, 0, dimensions)).toEqual({ left: 0, top: 0 });
    expect(mapFollowOffset(79, 20, dimensions)).toEqual({
      left: 400,
      top: 210,
    });
  });

  it("does not produce negative offsets when the full map fits", () => {
    expect(mapFollowOffset(40, 10, {
      scrollWidth: 800,
      scrollHeight: 420,
      clientWidth: 900,
      clientHeight: 500,
    })).toEqual({ left: 0, top: 0 });
  });
});
