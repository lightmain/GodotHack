import { expect, test } from "@playwright/test";

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

const ITEM_COUNTS = [20, 100, 300] as const;

test("renders, updates, and scrolls large permanent inventories", async ({
  page,
}, testInfo) => {
  await page.goto("test/integration-tests/performance/inventory-harness.html");
  await expect(page.locator("html")).toHaveAttribute(
    "data-inventory-performance-ready",
    "true",
  );

  const results: InventoryPerformanceResult[] = [];
  for (const itemCount of ITEM_COUNTS) {
    const result = await page.evaluate(async (count) => {
      return window.inventoryPerformanceHarness.measure(count);
    }, itemCount);
    results.push(result);
    expect(result.rowCount).toBe(itemCount);
    expect(result.commitDurationMs).toBeLessThan(1_000);
    expect(result.scrollDurationMs).toBeLessThan(250);
    if (itemCount >= 100) {
      expect(result.scrollHeight).toBeGreaterThan(result.clientHeight);
      expect(result.scrollTop).toBeGreaterThan(0);
    }
  }

  await testInfo.attach("permanent-inventory-performance.json", {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });
  console.log(`Permanent inventory performance: ${JSON.stringify(results)}`);
});
