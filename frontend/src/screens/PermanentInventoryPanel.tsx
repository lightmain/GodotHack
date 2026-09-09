import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PermanentInventoryState } from "../game-state";
import type { PermanentInventoryPosition } from "../settings/profile";
import { colorClass, textAttributeClass } from "../text-styling";

interface PermanentInventoryPanelProps {
  collapsed: boolean;
  inventory: PermanentInventoryState;
  onCollapsedChange(collapsed: boolean): void;
  position: PermanentInventoryPosition;
}

/**
 * Render NetHack's committed permanent-inventory snapshot without actions.
 */
export function PermanentInventoryPanel({
  collapsed,
  inventory,
  onCollapsedChange,
  position,
}: PermanentInventoryPanelProps) {
  const itemCount = inventory.items.filter(
    (item) => item.identifier !== null,
  ).length;
  const toggleLabel = collapsed ? "Expand inventory" : "Collapse inventory";

  return (
    <aside
      aria-label="Inventory"
      className={`permanent-inventory permanent-inventory-${position}${collapsed ? " permanent-inventory-collapsed" : ""}`}
      data-browser-keyboard
      data-position={position}
      role="region"
      tabIndex={collapsed ? -1 : 0}
    >
      <header className="permanent-inventory-header">
        <div>
          <strong>{inventory.prompt || "Inventory"}</strong>
          <span>{itemCount} {itemCount === 1 ? "item" : "items"}</span>
        </div>
        <button
          aria-label={toggleLabel}
          onClick={(event) => {
            event.currentTarget.blur();
            onCollapsedChange(!collapsed);
          }}
          tabIndex={0}
          title={toggleLabel}
          type="button"
        >
          {collapsed
            ? <ChevronRight aria-hidden="true" size={17} />
            : <ChevronLeft aria-hidden="true" size={17} />}
        </button>
      </header>
      {!collapsed && (
        <div className="nh-menu-items permanent-inventory-items">
          {inventory.items.map((item, index) => {
            const glyph = item.glyph?.ttyChar
              ? String.fromCodePoint(item.glyph.ttyChar)
              : "";
            const accelerator = item.accelerator
              ? String.fromCodePoint(item.accelerator)
              : "";
            return (
              item.identifier === null
                ? (
                  <div
                    className={`nh-menu-heading permanent-inventory-heading ${textAttributeClass(item.attribute)}`}
                    key={`${inventory.revision}-${index}`}
                  >
                    {item.text || "\u00a0"}
                  </div>
                )
                : (
                  <button
                    aria-disabled="true"
                    className={[
                      "nh-menu-item",
                      "permanent-inventory-item",
                      item.itemFlags !== 0 ? "selected" : "",
                      colorClass(item.color),
                      textAttributeClass(item.attribute),
                    ].filter(Boolean).join(" ")}
                    key={`${inventory.revision}-${index}`}
                    onFocus={(event) => event.currentTarget.blur()}
                    tabIndex={-1}
                    type="button"
                  >
                    <span aria-hidden="true" className="nh-menu-glyph">
                      {glyph || " "}
                    </span>
                    <span aria-hidden="true" className="nh-menu-mark">
                      {" "}
                    </span>
                    <span
                      aria-hidden="true"
                      className="nh-menu-accelerator"
                    >
                      {accelerator || " "}
                    </span>
                    <span className="nh-menu-text">{item.text}</span>
                  </button>
                )
            );
          })}
        </div>
      )}
    </aside>
  );
}
