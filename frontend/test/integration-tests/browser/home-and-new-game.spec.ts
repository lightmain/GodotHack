import { expect, test } from "./fixtures";
import { captureErrors } from "./helpers/browser-errors";
import { exportDiagnosticLog } from "./helpers/diagnostic-artifact";
import {
  moveToAdjacentFloor,
  openHome,
  saveAndReturnHome,
  startNewGame,
  startNewGameFromHome,
} from "./helpers/game-flow";
import { openSavePicker } from "./helpers/save-flow";

test("starts no NetHack session before the player begins a game", async ({
  page,
}) => {
  const errors = captureErrors(page);
  await openHome(page, "initial-lifecycle");
  await expect(page.locator(".home-version")).toHaveText("prealpha-4");
  await expect(page.locator(".home-footer")).toContainText(
    "BlissHack prealpha-4",
  );
  await expect(page.locator(".nh-shell")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Settings" })).toBeEnabled();

  const picker = await openSavePicker(page);
  await expect(picker.getByText("No saved games")).toBeVisible();
  await page.keyboard.press("Escape");
  const initial = await exportDiagnosticLog(page);
  expect(initial.diagnostic.events.filter(
    ({ event }) => event === "wasm.main_started",
  )).toHaveLength(0);
  expect(initial.diagnostic.events.filter(
    ({ event }) => event === "session.created",
  )).toHaveLength(0);

  await startNewGameFromHome(page, "E2E_OneSession");
  await saveAndReturnHome(page);
  const afterGame = await exportDiagnosticLog(page);
  expect(afterGame.diagnostic.events.filter(
    ({ event }) => event === "wasm.main_started",
  )).toHaveLength(1);
  expect(afterGame.diagnostic.events.filter(
    ({ event }) => event === "session.created",
  )).toHaveLength(1);
  expect(errors).toEqual({ console: [], page: [] });
});

test("q quits character selection and returns home", async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto("?integration=quit-role-selection");
  await page.getByRole("button", { name: "New Game" }).click();

  const nameInput = page.getByRole("textbox", { name: "Who are you?" });
  await nameInput.fill("E2E_Quit");
  await nameInput.press("Enter");
  await expect(page.getByText(/Shall I pick character's/)).toBeVisible();

  await page.keyboard.press("q");

  await expect(page.getByRole("button", { name: "New Game" })).toBeVisible();
  await expect(page.locator(".nh-shell")).toHaveCount(0);
  expect(errors).toEqual({ console: [], page: [] });
});

test("plays through startup and routes terminal UI input", async ({ page }) => {
  const errors = captureErrors(page);
  await startNewGame(page, "E2E_Ada");

  const messageMetrics = await page.locator(".nh-messages").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      requiredHeight: Number.parseFloat(style.lineHeight) * 3
        + Number.parseFloat(style.paddingTop)
        + Number.parseFloat(style.paddingBottom),
    };
  });
  expect(messageMetrics.height).toBeGreaterThanOrEqual(
    messageMetrics.requiredHeight - 0.5,
  );

  await expect(page.getByLabel(/E2E_Ada the .+, 100% HP/)).toBeVisible();
  await expect(page.locator(".nh-map-row")).toHaveCount(21);
  expect(
    await page.locator(".nh-map-row").evaluateAll(
      (rows) => rows.every((row) => row.textContent?.length === 80),
    ),
  ).toBe(true);

  const fill = page.locator(".nh-hp-fill");
  await expect(fill).toHaveClass(/nh-hp-full/);
  expect(await fill.textContent()).toHaveLength(30);
  expect(
    await fill.evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");

  const firstStatusRow = page.locator(".nh-status > div").first();
  const titleBox = await firstStatusRow.locator(":scope > span").first()
    .boundingBox();
  const strengthBox = await firstStatusRow.locator(":scope > span").nth(1)
    .boundingBox();
  expect(titleBox).not.toBeNull();
  expect(strengthBox).not.toBeNull();
  expect(strengthBox!.x - titleBox!.x - titleBox!.width).toBeGreaterThan(4);

  await page.keyboard.press("Control+p");
  await expect(
    page.getByRole("dialog", { name: "Message history" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page.keyboard.press("Alt+a");
  await expect(page.getByText(/What do you want to adjust/)).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Alt+u");
  await expect(page.getByText("In what direction?", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("o");
  await expect(page.getByText("In what direction?", { exact: true })).toBeVisible();
  await page.keyboard.press("Alt+h");
  await expect(page.getByText("In what direction?", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await moveToAdjacentFloor(page);
  expect(errors).toEqual({ console: [], page: [] });
});

test("warns that a New Game name will continue an existing save", async ({
  page,
}) => {
  const errors = captureErrors(page);
  const name = "E2ENameHint";
  const hint = "A save with this name already exists. "
    + "The game will continue from that save.";
  await startNewGame(page, name);
  await saveAndReturnHome(page);

  await page.getByRole("button", { name: "New Game" }).click();
  const nameInput = page.getByRole("textbox", { name: "Who are you?" });
  await nameInput.fill("DifferentName");
  await expect(page.getByText(hint, { exact: true })).toHaveCount(0);

  await nameInput.fill(`  ${name}  `);
  await expect(page.getByText(hint, { exact: true })).toBeVisible();
  await nameInput.press("Enter");
  await expect(page.locator(".nh-hp-bar")).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual({ console: [], page: [] });
});
