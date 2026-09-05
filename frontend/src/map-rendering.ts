import { COLNO, ROWNO, type MapCell } from "./game-state";

/** One adjacent sequence of map cells sharing the same visible style. */
export interface MapRun {
  start: number;
  text: string;
  color: number;
  pet: boolean;
  cursor: boolean;
}

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ScrollDimensions {
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}

/**
 * Collapse one map row into adjacent text runs with equal visible styles.
 * @param row - map cells in column order.
 * @param cursorX - cursor column for this row, or -1 when absent.
 * @returns compact text runs which reconstruct the complete row.
 */
export function buildMapRuns(
  row: readonly MapCell[],
  cursorX: number,
): MapRun[] {
  const runs: MapRun[] = [];
  for (let x = 0; x < row.length; x += 1) {
    const glyph = row[x].foreground;
    const color = glyph?.color ?? 7;
    const pet = glyph !== null && (glyph.glyphFlags & 0x10) !== 0;
    const cursor = x === cursorX;
    const character = glyphCharacter(glyph?.ttyChar ?? 32);
    const previous = runs[runs.length - 1];

    if (
      previous
      && previous.color === color
      && previous.pet === pet
      && previous.cursor === cursor
    ) {
      previous.text += character;
    } else {
      runs.push({ start: x, text: character, color, pet, cursor });
    }
  }
  return runs;
}

/**
 * Convert browser pointer coordinates into a valid NetHack map position.
 * @param clientX - pointer viewport x-coordinate.
 * @param clientY - pointer viewport y-coordinate.
 * @param rect - rendered map bounds.
 * @returns a map coordinate, excluding NetHack's unused column zero.
 */
export function mapPositionFromPoint(
  clientX: number,
  clientY: number,
  rect: RectLike,
): { x: number; y: number } | null {
  if (
    rect.width <= 0
    || rect.height <= 0
    || clientX < rect.left
    || clientX >= rect.left + rect.width
    || clientY < rect.top
    || clientY >= rect.top + rect.height
  ) {
    return null;
  }

  const x = Math.floor(((clientX - rect.left) / rect.width) * COLNO);
  const y = Math.floor(((clientY - rect.top) / rect.height) * ROWNO);
  return x >= 1 && x < COLNO && y >= 0 && y < ROWNO ? { x, y } : null;
}

/**
 * Center one map coordinate within a scroll viewport and clamp both axes.
 * @param x - NetHack map column.
 * @param y - NetHack map row.
 * @param dimensions - rendered map and viewport sizes.
 * @returns target scroll offsets.
 */
export function mapFollowOffset(
  x: number,
  y: number,
  dimensions: ScrollDimensions,
): { left: number; top: number } {
  const maxLeft = Math.max(0, dimensions.scrollWidth - dimensions.clientWidth);
  const maxTop = Math.max(0, dimensions.scrollHeight - dimensions.clientHeight);
  const cellCenterX = ((x + 0.5) / COLNO) * dimensions.scrollWidth;
  const cellCenterY = ((y + 0.5) / ROWNO) * dimensions.scrollHeight;
  return {
    left: clamp(cellCenterX - dimensions.clientWidth / 2, 0, maxLeft),
    top: clamp(cellCenterY - dimensions.clientHeight / 2, 0, maxTop),
  };
}

/**
 * Convert a tty character code into one visible map character.
 * @param value - glyph_info.ttychar.
 * @returns one display character.
 */
function glyphCharacter(value: number): string {
  if (value < 0x20 || value > 0x10ffff) return " ";
  return String.fromCodePoint(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
