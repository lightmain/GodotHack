import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PermanentInventoryState } from "../game-state";
import { PermanentInventoryPanel } from "./PermanentInventoryPanel";

const inventory: PermanentInventoryState = {
  revision: 4,
  windowId: 9,
  prompt: "Inventory",
  items: [
    {
      glyph: null,
      identifier: null,
      accelerator: 0,
      groupAccelerator: 0,
      attribute: 1,
      color: 7,
      text: "Weapons",
      itemFlags: 0,
    },
    {
      glyph: {
        glyph: 12,
        ttyChar: ")".charCodeAt(0),
        frameColor: 0,
        glyphFlags: 0,
        color: 2,
        symbolIndex: 0,
        customColor: 0,
        color256: 0,
        tileIndex: 0,
      },
      identifier: 41,
      accelerator: "a".charCodeAt(0),
      groupAccelerator: 0,
      attribute: 0,
      color: 2,
      text: "a blessed long sword (weapon in hand)",
      itemFlags: 1,
    },
  ],
};

function renderPanel(collapsed: boolean): string {
  return renderToStaticMarkup(createElement(PermanentInventoryPanel, {
    collapsed,
    inventory,
    onCollapsedChange: vi.fn(),
    position: "right",
  }));
}

describe("PermanentInventoryPanel", () => {
  it("renders core-provided rows as a focusable, non-interactive region", () => {
    const html = renderPanel(false);

    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Inventory"');
    expect(html).toContain("data-browser-keyboard");
    expect(html).toContain('tabindex="0"');
    expect(html).toMatch(/1 item/);
    expect(html).toContain('aria-label="Collapse inventory"');
    expect(html).toContain('title="Collapse inventory"');
    expect(html).toContain("Weapons");
    expect(html).toContain("a blessed long sword (weapon in hand)");
    expect(html).toContain(")");
    expect(html).toMatch(/>a<\/span>/);
    expect(html).toContain("nh-color-green");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toMatch(/selected/);
    expect((html.match(/<button\b/g) ?? [])).toHaveLength(2);
    expect((html.match(/tabindex="-1"/g) ?? [])).toHaveLength(1);
  });

  it("collapses to a labelled control without exposing stale item rows", () => {
    const html = renderPanel(true);

    expect(html).toContain('aria-label="Expand inventory"');
    expect(html).toContain('title="Expand inventory"');
    expect(html).not.toContain("Weapons");
    expect(html).not.toContain("a blessed long sword");
    expect(html).toMatch(/right/);
    expect(html).not.toContain("data-width");
    expect(html).toContain('tabindex="-1"');
  });
});
