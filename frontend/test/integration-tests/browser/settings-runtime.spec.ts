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
  await page.getByRole("button", { name: "Apply" }).click();

  await startWithoutTutorial(page, name);
  await expect(page.locator(".nh-shell")).toHaveAttribute(
    "data-number-pad",
    "on",
  );
  await expect(page.locator(".nh-status")).toContainText(/T:\d+/);
  await expect(
    page.getByRole("dialog", { name: "Do you want a tutorial?" }),
  ).toHaveCount(0);

  await saveAndReturnHome(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("combobox", { name: "Movement keys" })
    .selectOption("0");
  await page.getByRole("checkbox", { name: "Show turn count" }).uncheck();
  await page.getByRole("button", { name: "Apply" }).click();

  await continueSavedGame(page, name);
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

  await startWithoutTutorial(page, "PermInventory");
  const inventory = page.getByRole("region", { name: "Inventory" });
  await expect(inventory).toBeVisible();
  await expect(inventory).toContainText(/\d+ items?/);
  await expect(page.locator(".nh-dialog.nh-menu")).toHaveCount(0);

  await page.getByRole("button", { name: "Collapse inventory" }).click();
  await expect(
    page.getByRole("button", { name: "Expand inventory" }),
  ).toBeVisible();
  await expect(inventory.locator(".permanent-inventory-item")).toHaveCount(0);

  await page.setViewportSize({ width: 900, height: 900 });
  const collapsedBox = await inventory.boundingBox();
  expect(collapsedBox?.width).toBeLessThan(80);

  await page.keyboard.press("i");
  await expect(page.locator(".nh-dialog.nh-menu")).toBeVisible();
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

  await expect(page.getByText(/Shall I pick character's/)).toBeVisible();
  await page.keyboard.press("y");
  await expect(
    page.getByRole("dialog", { name: "Is this ok? [ynq]" }),
  ).toBeVisible();
  await page.keyboard.press("y");
  await expect(page.locator(".nh-text-dialog")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".nh-hp-bar")).toBeVisible();
}
