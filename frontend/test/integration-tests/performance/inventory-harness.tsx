import { Profiler } from "react";
import { createRoot } from "react-dom/client";
import "../../../src/index.css";
import "../../../src/App.css";
import type {
  MenuItem,
  PermanentInventoryState,
} from "../../../src/game-state";
import { PermanentInventoryPanel } from "../../../src/screens/PermanentInventoryPanel";

interface InventoryPerformanceResult {
  clientHeight: number;
  commitDurationMs: number;
  itemCount: number;
  rowCount: number;
  scrollDurationMs: number;
  scrollHeight: number;
  scrollTop: number;
}

declare global {
  interface Window {
    inventoryPerformanceHarness: {
      measure(itemCount: number): Promise<InventoryPerformanceResult>;
    };
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Performance harness root is missing");
const root = createRoot(rootElement);
let revision = 0;

/**
 * Create deterministic menu rows without involving NetHack random generation.
 * @param itemCount - number of inventory item rows to create.
 * @returns immutable menu rows accepted by the production inventory component.
 */
function createItems(itemCount: number): MenuItem[] {
  return Array.from({ length: itemCount }, (_, index) => ({
    glyph: null,
    identifier: index + 1,
    accelerator: 97 + (index % 26),
    groupAccelerator: 0,
    attribute: 0,
    color: index % 16,
    text: `performance item ${index + 1} with a stable descriptive name`,
    itemFlags: index % 9 === 0 ? 1 : 0,
  }));
}

/**
 * Wait until the browser has completed one rendering frame.
 * @returns a promise resolved after the next animation frame.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * Render and scroll one inventory size through the production React component.
 * @param itemCount - number of synthetic inventory rows.
 * @returns component commit and scroll measurements.
 */
async function measureInventory(
  itemCount: number,
): Promise<InventoryPerformanceResult> {
  revision += 1;
  const inventory: PermanentInventoryState = {
    revision,
    windowId: 1,
    prompt: "Inventory",
    items: createItems(itemCount),
  };
  let resolveCommit: ((duration: number) => void) | null = null;
  const committed = new Promise<number>((resolve) => {
    resolveCommit = resolve;
  });
  root.render(
    <div className="nh-font-medium performance-inventory-shell">
      <Profiler
        id="permanent-inventory"
        onRender={(_id, _phase, actualDuration) => {
          resolveCommit?.(actualDuration);
          resolveCommit = null;
        }}
      >
        <PermanentInventoryPanel
          collapsed={false}
          inventory={inventory}
          onCollapsedChange={() => undefined}
          position="right"
        />
      </Profiler>
    </div>,
  );
  const commitDurationMs = await committed;
  await nextFrame();

  const scroller = document.querySelector<HTMLElement>(
    ".permanent-inventory-items",
  );
  if (!scroller) throw new Error("Inventory scroll container is missing");
  const scrollStarted = performance.now();
  scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  await nextFrame();

  return {
    clientHeight: scroller.clientHeight,
    commitDurationMs,
    itemCount,
    rowCount: document.querySelectorAll(".permanent-inventory-item").length,
    scrollDurationMs: performance.now() - scrollStarted,
    scrollHeight: scroller.scrollHeight,
    scrollTop: scroller.scrollTop,
  };
}

window.inventoryPerformanceHarness = { measure: measureInventory };
document.documentElement.dataset.inventoryPerformanceReady = "true";
