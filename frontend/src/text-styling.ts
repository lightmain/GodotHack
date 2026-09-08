import {
  ATR_BOLD,
  ATR_DIM,
  ATR_INVERSE,
  ATR_ITALIC,
  ATR_ULINE,
} from "./game-state";

const COLOR_NAMES = [
  "black",
  "red",
  "green",
  "brown",
  "blue",
  "magenta",
  "cyan",
  "gray",
  "dark-gray",
  "bright-red",
  "bright-green",
  "yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "white",
] as const;

/**
 * Convert a NetHack color index into a CSS class.
 * @param value - CLR_* index.
 * @returns a stable class name.
 */
export function colorClass(value: number): string {
  const name = COLOR_NAMES[value] ?? "gray";
  return `nh-color-${name}`;
}

/**
 * Convert ATR_* flags into CSS classes.
 * @param attribute - NetHack text attributes.
 * @returns space-separated CSS classes.
 */
export function textAttributeClass(attribute: number): string {
  const classes: string[] = [];
  const base = attribute & 0x0f;
  if (base === ATR_BOLD) classes.push("nh-bold");
  if (base === ATR_DIM) classes.push("nh-dim");
  if (base === ATR_ITALIC) classes.push("nh-italic");
  if (base === ATR_ULINE) classes.push("nh-underline");
  if (base === ATR_INVERSE) classes.push("nh-inverse");
  return classes.join(" ");
}
