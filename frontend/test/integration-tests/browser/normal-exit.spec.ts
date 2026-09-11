import { expect, test } from "./fixtures";
import { captureErrors } from "./helpers/browser-errors";
import { exportDiagnosticLog } from "./helpers/diagnostic-artifact";
import {
  quitAndReturnHome,
  openHome,
  saveAndReturnHome,
  startNewGame,
  startNewGameFromHome,
} from "./helpers/game-flow";

test("quits an active game and starts a clean second session", async ({
  page,
}) => {
  const errors = captureErrors(page);
  await startNewGame(page, "E2E_ActiveQuit");
  await quitAndReturnHome(page);

  await expect(page.locator(".nh-shell")).toHaveCount(0);
  await startNewGameFromHome(page, "E2E_AfterQuit");
  await expect(page.getByLabel(/E2E_AfterQuit the .+, 100% HP/)).toBeVisible();
  await saveAndReturnHome(page);

  const { diagnostic } = await exportDiagnosticLog(page);
  const sessionIds = diagnostic.events
    .filter(({ event }) => event === "session.created")
    .map(({ sessionId }) => sessionId);
  const moduleIds = diagnostic.events
    .filter(({ event }) => event === "module.loading")
    .map(({ moduleId }) => moduleId);
  expect(sessionIds).toHaveLength(2);
  expect(sessionIds.every(Boolean)).toBe(true);
  expect(new Set(sessionIds).size).toBe(2);
  expect(moduleIds.length).toBeGreaterThanOrEqual(3);
  expect(moduleIds.every(Boolean)).toBe(true);
  expect(new Set(moduleIds).size).toBe(moduleIds.length);
  expect(errors).toEqual({ console: [], page: [] });
});

test("retains the last permanent inventory through end-game disclosure", async ({
  page,
}) => {
  const errors = captureErrors(page);
  await openHome(page, "inventory-at-gameover");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("checkbox", {
    name: "Enable Permanent Inventory",
    exact: true,
  }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await startNewGameFromHome(page, "InventoryGameover");

  const inventory = page.getByRole("region", { name: "Inventory" });
  await expect(inventory).toBeVisible();
  const lastItem = inventory.locator(".permanent-inventory-item").last();
  const lastItemText = await lastItem.textContent();
  expect(lastItemText?.trim()).not.toBe("");

  await page.keyboard.press("#");
  const commandDialog = page.getByRole("dialog", { name: "Extended command" });
  await expect(commandDialog).toBeVisible();
  await commandDialog.locator("input").fill("quit");
  await commandDialog.locator("input").press("Enter");
  await expect(page.getByText(/Really quit without saving/)).toBeVisible();
  await page.keyboard.press("y");
  await expect(page.getByText(
    /Do you want (your possessions identified|to see)/,
  )).toBeVisible();
  await expect(inventory).toBeVisible();
  await expect(inventory).toContainText(lastItemText ?? "");
  expect(errors).toEqual({ console: [], page: [] });
});
