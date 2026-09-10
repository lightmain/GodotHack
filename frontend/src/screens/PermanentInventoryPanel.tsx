import {
  useRef,
  type FocusEvent,
} from "react";
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
  const mouseFocusRef = useRef(false);
  const itemCount = inventory.items.filter(
    (item) => item.identifier !== null,
  ).length;
  const toggleLabel = collapsed ? "Expand inventory" : "Collapse inventory";

  /**
   * Mark the start of a mouse gesture which may focus the panel container.
   */
  function handleMouseDown(): void {
    mouseFocusRef.current = true;
  }

  /**
   * Clear mouse focus intent after the gesture completes or leaves the panel.
   */
  function handleMouseEnd(): void {
    mouseFocusRef.current = false;
  }

  /**
   * Keep keyboard focus for scrolling, but release incidental mouse focus.
   * @param event - focus event delegated from the inventory panel.
   */
  function handleFocus(event: FocusEvent<HTMLElement>): void {
    if (
      event.target === event.currentTarget
      && mouseFocusRef.current
    ) {
      event.currentTarget.blur();
    }
  }

  return (
    <aside
      aria-label="Inventory"
      className={`permanent-inventory permanent-inventory-${position}${collapsed ? " permanent-inventory-collapsed" : ""}`}
      data-browser-keyboard
      data-position={position}
      onFocus={handleFocus}
      onMouseDown={handleMouseDown}
      onMouseLeave={handleMouseEnd}
      onMouseUp={handleMouseEnd}
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
