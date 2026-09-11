import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { captureErrors } from "./helpers/browser-errors";
import {
  continueSavedGame,
  openHome,
  saveAndReturnHome,
} from "./helpers/game-flow";

test("installs current settings for new and continued games", async ({ page }) => {
  const errors = captureErrors(page);
  const name = "RcSettings";
  await openHome(page, "settings-runtime");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("checkbox", {
    name: "Offer tutorial for new games",
  }).uncheck();
  await page.getByRole("combobox", { name: "Movement keys" })
    .selectOption("1");
  await page.getByRole("checkbox", { name: "Show turn count" }).check();
  await page.getByRole("checkbox", { name: "Permanent inventory" }).check();
  await page.getByRole("button", { name: "Apply" }).click();

  await startWithoutTutorial(page, name);
  const inventory = page.getByRole("region", { name: "Inventory" });
  const retainedItem = await inventory.locator(
    ".permanent-inventory-item:not(.permanent-inventory-heading)",
  ).first().textContent();
  await expect(page.locator(".nh-shell")).toHaveAttribute(
    "data-number-pad",
    "on",
  );
  await expect(page.locator(".nh-status")).toContainText(/T:\d+/);
  await expect(
    page.getByRole("dialog", { name: "Do you want a tutorial?" }),
  ).toHaveCount(0);

  await saveAndReturnHome(page);
  await expect(inventory).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("combobox", { name: "Movement keys" })
    .selectOption("0");
  await page.getByRole("checkbox", { name: "Show turn count" }).uncheck();
  await page.getByRole("button", { name: "Apply" }).click();

  await continueSavedGame(page, name);
  await expect(inventory).toBeVisible();
  await expect(inventory).toContainText(retainedItem ?? "");
  await expect(page.getByLabel(new RegExp(`${name} the .+, \\d+% HP`)))
    .toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".nh-shell")).toHaveAttribute(
    "data-number-pad",
    "off",
  );
  await expect(page.locator(".nh-status")).toContainText(/T:\d+/);
  expect(errors).toEqual({ console: [], page: [] });
});

test("renders and collapses the core permanent inventory without a modal", async ({
  page,
}) => {
  const errors = captureErrors(page);
  await openHome(page, "permanent-inventory");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("checkbox", {
    name: "Offer tutorial for new games",
  }).uncheck();
  await page.getByRole("checkbox", { name: "Permanent inventory" }).check();
  await page.getByRole("button", { name: "Apply" }).click();

  await startWithoutTutorial(page, "PermInventory-Wiz");
  const inventory = page.getByRole("region", { name: "Inventory" });
  await expect(inventory).toBeVisible();
  await expect(inventory).toContainText(/\d+ items?/);
  await expect(page.locator(".nh-dialog.nh-menu")).toHaveCount(0);
  const viewport = page.viewportSize();
  const mapBox = await page.locator(".nh-map").boundingBox();
  const inventoryBox = await inventory.boundingBox();
  expect(inventoryBox?.width).toBeGreaterThan(500);
  expect((mapBox?.x ?? 0) + (mapBox?.width ?? 0) / 2).toBeLessThan(
    (viewport?.width ?? 0) / 2 - 200,
  );

  await inventory.focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Collapse inventory" }),
  ).toBeFocused();
  await inventory.focus();
  await page.evaluate(() => {
    document.documentElement.dataset.lastKeyDefaultPrevented = "";
    globalThis.addEventListener("keydown", (event) => {
      document.documentElement.dataset.lastKeyDefaultPrevented =
        String(event.defaultPrevented);
    }, { once: true });
  });
  await page.keyboard.press("PageDown");
  await expect(page.locator("html")).toHaveAttribute(
    "data-last-key-default-prevented",
    "false",
  );

  const permanentHeading = inventory.locator(".nh-menu-heading").first();
  await expect(permanentHeading).toHaveCSS("font-weight", "700");
  await expect(permanentHeading).toHaveCSS("margin-top", "4px");
  await expect(permanentHeading).toHaveCSS("margin-bottom", "4px");
  const inventoryRows = inventory.locator(
    ".permanent-inventory-item:not(.permanent-inventory-heading)",
  );
  const firstInventoryRow = inventoryRows.first();
  const [firstRowBox, firstTextBox] = await Promise.all([
    firstInventoryRow.boundingBox(),
    firstInventoryRow.locator(".nh-menu-text").boundingBox(),
  ]);
  const permanentHeadingBox = await permanentHeading.boundingBox();
  expect(firstRowBox).not.toBeNull();
  expect(firstTextBox).not.toBeNull();
  expect(permanentHeadingBox).not.toBeNull();
  expect(
    firstRowBox!.y - permanentHeadingBox!.y - permanentHeadingBox!.height,
  ).toBeGreaterThanOrEqual(4);
  expect(firstTextBox!.width).toBeGreaterThan(firstRowBox!.width / 2);
  await firstInventoryRow.hover();
  await expect(firstInventoryRow).toHaveCSS(
    "background-color",
    "rgb(27, 32, 35)",
  );
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.mouse.click(
    firstRowBox!.x + firstRowBox!.width / 2,
    firstRowBox!.y + firstRowBox!.height / 2,
  );
  expect(await inventory.evaluate(
    (panel) => !panel.contains(document.activeElement),
  )).toBe(true);
  await inventory.locator(".permanent-inventory-header strong").click();
  expect(await inventory.evaluate(
    (panel) => !panel.contains(document.activeElement),
  )).toBe(true);
  await page.keyboard.press("i");
  const keyboardInventory = page.locator(".nh-dialog.nh-menu");
  await expect(keyboardInventory).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(keyboardInventory).toHaveCount(0);

  await inventory.focus();
  await expect(inventory).toBeFocused();
  await page.locator(".nh-map").click({ position: { x: 2, y: 2 } });
  expect(await inventory.evaluate(
    (panel) => !panel.contains(document.activeElement),
  )).toBe(true);
  await page.keyboard.press("i");
  await expect(keyboardInventory).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(keyboardInventory).toHaveCount(0);

  const allCount = await inventoryRows.count();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await setInventoryMode(page, "full");
  const fullCount = await inventoryRows.count();
  expect(fullCount).toBeGreaterThanOrEqual(allCount);

  await setInventoryMode(page, "in-use");
  await expect(inventory).toContainText(/being worn|weapon in hand/i);
  const inUseCount = await inventoryRows.count();
  expect(inUseCount).toBeGreaterThan(0);
  expect(inUseCount).toBeLessThan(fullCount);

  await setInventoryMode(page, "all");
  await expect(inventoryRows).toHaveCount(allCount);

  const wornRow = inventoryRows.filter({ hasText: "being worn" }).first();
  await expect(wornRow).toBeVisible();
  const wornText = (await wornRow.textContent()) ?? "";
  const wornKey = (await wornRow.locator(
    ".nh-menu-accelerator",
  ).textContent())?.trim();
  expect(wornKey).toMatch(/^[a-zA-Z]$/);
  await page.keyboard.press("T");
  await page.keyboard.press(wornKey!);
  await expect(inventory).not.toContainText(wornText);
  await page.keyboard.press("W");
  await page.keyboard.press(wornKey!);
  await expect(inventory).toContainText(wornText);
  await expect(page.locator(".nh-shell")).toHaveAttribute(
    "data-command-input",
    "ready",
  );

  const countBeforeDrop = await inventoryRows.count();
  await page.keyboard.press("d");
  await expect(page.locator(".nh-prompt")).toContainText(
    /What do you want to drop/,
  );
  const [promptBox, statusBox] = await Promise.all([
    page.locator(".nh-prompt").boundingBox(),
    page.locator(".nh-status").boundingBox(),
  ]);
  expect(promptBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  expect(Math.abs(promptBox!.x - statusBox!.x)).toBeLessThan(1);
  expect(
    Math.abs(promptBox!.y - statusBox!.y - statusBox!.height),
  ).toBeLessThan(1);
  await page.keyboard.press("Shift+Slash");
  const dropMenu = page.locator(".nh-dialog.nh-menu");
  await expect(dropMenu).toBeVisible();
  await dropMenu.locator(".nh-menu-item")
    .filter({ hasNotText: /being worn/ })
    .last()
    .click();
  await expect(inventoryRows).toHaveCount(countBeforeDrop - 1);
  await page.keyboard.press(",");
  const pickupMenu = page.locator(".nh-dialog.nh-menu");
  if (await pickupMenu.isVisible()) {
    await pickupMenu.locator(".nh-menu-item").first().click();
  }
  await expect(inventoryRows).toHaveCount(countBeforeDrop);

  await page.getByRole("button", { name: "Collapse inventory" }).click();
  await expect(
    page.getByRole("button", { name: "Expand inventory" }),
  ).toBeVisible();
  await expect(inventory.locator(".permanent-inventory-item")).toHaveCount(0);

  await page.setViewportSize({ width: 900, height: 900 });
  const collapsedBox = await inventory.boundingBox();
  const expandButtonBox = await page.getByRole(
    "button",
    { name: "Expand inventory" },
  ).boundingBox();
  expect(collapsedBox?.width).toBeCloseTo(42, 4);
  expect(expandButtonBox?.x).toBeGreaterThanOrEqual(collapsedBox?.x ?? 0);
  expect(
    (expandButtonBox?.x ?? 0) + (expandButtonBox?.width ?? 0),
  ).toBeLessThanOrEqual(
    (collapsedBox?.x ?? 0) + (collapsedBox?.width ?? 0),
  );
  expect(Math.abs(
    (expandButtonBox?.x ?? 0) + (expandButtonBox?.width ?? 0) / 2
      - ((collapsedBox?.x ?? 0) + (collapsedBox?.width ?? 0) / 2),
  )).toBeLessThanOrEqual(0.5);
  await expect(inventory).toHaveCSS("border-top-width", "1px");
  await expect(inventory).toHaveCSS("border-right-width", "1px");
  await expect(inventory).toHaveCSS("border-bottom-width", "1px");
  await expect(inventory).toHaveCSS("border-left-width", "1px");
  await expect(inventory).toHaveCSS("border-radius", "4px");

  expect(await inventory.evaluate(
    (panel) => !panel.contains(document.activeElement),
  )).toBe(true);
  await page.keyboard.press("i");
  const ordinaryInventory = page.locator(".nh-dialog.nh-menu");
  await expect(ordinaryInventory).toBeVisible();
  const ordinaryHeading = ordinaryInventory.locator(".nh-menu-heading").first();
  await expect(ordinaryHeading).toHaveCSS("font-weight", "700");
  await expect(ordinaryHeading).toHaveCSS("margin-top", "4px");
  await expect(ordinaryHeading).toHaveCSS("margin-bottom", "4px");
  const [ordinaryHeadingBox, ordinaryFirstRowBox] = await Promise.all([
    ordinaryHeading.boundingBox(),
    ordinaryInventory.locator(".nh-menu-item").first().boundingBox(),
  ]);
  expect(ordinaryHeadingBox).not.toBeNull();
  expect(ordinaryFirstRowBox).not.toBeNull();
  expect(
    ordinaryFirstRowBox!.y - ordinaryHeadingBox!.y - ordinaryHeadingBox!.height,
  ).toBeGreaterThanOrEqual(4);
  await expect(
    ordinaryInventory.locator(".nh-menu-glyph").first(),
  ).toHaveText(/\S/);
  await expect(page.locator(".nh-terminal")).toHaveAttribute("inert", "");
  await page.keyboard.press("Tab");
  expect(await page.locator(".nh-terminal").evaluate(
    (terminal) => !terminal.contains(document.activeElement),
  )).toBe(true);
  await page.keyboard.press("Escape");
  expect(errors).toEqual({ console: [], page: [] });
});

/** Start a random character when !tutorial removes the final prompt. */
async function startWithoutTutorial(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New Game" }).click();
  const nameInput = page.getByRole("textbox", { name: "Who are you?" });
  await expect(nameInput).toBeVisible();
  await nameInput.fill(name);
  await nameInput.press("Enter");

  await expect(page.getByText(/Shall I pick/)).toBeVisible();
  await page.keyboard.press("y");
  await expect(
    page.getByRole("dialog", { name: "Is this ok? [ynq]" }),
  ).toBeVisible();
  await page.keyboard.press("y");
  await expect(page.locator(".nh-text-dialog")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".nh-hp-bar")).toBeVisible();
}

/**
 * Apply one permanent-inventory mode through the in-game Settings boundary.
 * @param page - running game page.
 * @param mode - select value exposed by perminv_mode.
 */
async function setInventoryMode(
  page: Page,
  mode: "all" | "full" | "in-use",
): Promise<void> {
  await page.keyboard.press("Escape");
  const pause = page.getByRole("dialog", { name: "Game paused" });
  await expect(pause).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("combobox", { name: "Contents" })
    .selectOption(mode);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(".nh-shell")).toHaveAttribute(
    "data-settings-status",
    "applied",
  );
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(pause).toHaveCount(0);
}
