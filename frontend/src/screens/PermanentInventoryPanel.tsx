import { ChevronDown, ChevronRight } from "lucide-react";
import type { PermanentInventoryState } from "../game-state";
import type {
  PermanentInventoryPosition,
  PermanentInventoryWidth,
} from "../settings/profile";

interface PermanentInventoryPanelProps {
  collapsed: boolean;
  inventory: PermanentInventoryState;
  onCollapsedChange(collapsed: boolean): void;
  position: PermanentInventoryPosition;
  width: PermanentInventoryWidth;
}

/**
 * Render NetHack's committed permanent-inventory snapshot without actions.
 */
export function PermanentInventoryPanel({
  collapsed,
  inventory,
  onCollapsedChange,
  position,
  width,
}: PermanentInventoryPanelProps) {
  const itemCount = inventory.items.filter(
    (item) => item.identifier !== null,
  ).length;
  const toggleLabel = collapsed ? "Expand inventory" : "Collapse inventory";

  return (
    <aside
      aria-label="Inventory"
      className={`permanent-inventory permanent-inventory-${position} permanent-inventory-${width}${collapsed ? " permanent-inventory-collapsed" : ""}`}
      data-position={position}
      data-width={width}
      role="region"
      tabIndex={0}
    >
      <header className="permanent-inventory-header">
        <div>
          <strong>{inventory.prompt || "Inventory"}</strong>
          <span>{itemCount} {itemCount === 1 ? "item" : "items"}</span>
        </div>
        <button
          aria-label={toggleLabel}
          onClick={() => onCollapsedChange(!collapsed)}
          title={toggleLabel}
          type="button"
        >
          {collapsed
            ? <ChevronRight aria-hidden="true" size={17} />
            : <ChevronDown aria-hidden="true" size={17} />}
        </button>
      </header>
      {!collapsed && (
        <div className="permanent-inventory-items">
          {inventory.items.map((item, index) => {
            const glyph = item.glyph?.ttyChar
              ? String.fromCodePoint(item.glyph.ttyChar)
              : "";
            const accelerator = item.accelerator
              ? String.fromCodePoint(item.accelerator)
              : "";
            return (
              <div
                className={`permanent-inventory-item${item.identifier === null ? " permanent-inventory-heading" : ""}${item.itemFlags !== 0 ? " selected" : ""}`}
                key={`${inventory.revision}-${index}`}
              >
                <span aria-hidden="true" className="permanent-inventory-glyph">
                  {glyph}
                </span>
                <span aria-hidden="true" className="permanent-inventory-key">
                  {accelerator}
                </span>
                <span>{item.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
