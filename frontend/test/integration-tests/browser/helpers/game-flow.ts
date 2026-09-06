import { expect, type Page } from "@playwright/test";

/** Stable player position read from the rendered NetHack cursor. */
export interface CursorPosition {
  x: number;
  y: number;
}

/**
 * Open a fresh application page and verify the prepared Home screen.
 * @param page - Playwright page under test.
 * @param marker - unique query value used to distinguish the test navigation.
 */
export async function openHome(page: Page, marker: string): Promise<void> {
  await page.goto(`?integration=${encodeURIComponent(marker)}`);
  await expect(page.getByRole("heading", { name: "BlissHack" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Settings" })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Who are you?" })).toHaveCount(0);
  await expect(page.getByText(
    "This browser cannot protect games opened in multiple BlissHack pages.",
  )).toHaveCount(0);
  await expect(page.getByRole("alertdialog", {
    name: "BlissHack is busy in another page",
  })).toHaveCount(0);
}

/**
 * Start a new game through the real askname and random role-selection flow.
 * @param page - page currently showing the prepared Home screen.
 * @param name - unique player name.
 */
export async function startNewGameFromHome(
  page: Page,
  name: string,
): Promise<void> {
  await page.getByRole("button", { name: "New Game" }).click();

  const nameInput = page.getByRole("textbox", { name: "Who are you?" });
  await expect(nameInput).toBeVisible();
  await expect(page.getByText(/Shall I pick character's/)).toHaveCount(0);
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

  await expect(
    page.getByRole("dialog", { name: "Do you want a tutorial?" }),
  ).toBeVisible();
  await page.keyboard.press("n");

  await expect(page.locator(".nh-hp-bar")).toBeVisible();
}

/**
 * Navigate to Home and start a complete new game.
 * @param page - Playwright page under test.
 * @param name - unique player name.
 */
export async function startNewGame(page: Page, name: string): Promise<void> {
  await openHome(page, name);
  const [commands, identity] = await Promise.all([
    page.locator(".home-commands").boundingBox(),
    page.locator(".home-identity").boundingBox(),
  ]);
  expect(Math.abs((commands?.x ?? 0) - (identity?.x ?? 0))).toBeLessThan(2);
  expect(commands?.y).toBeGreaterThan(
    (identity?.y ?? 0) + (identity?.height ?? 0),
  );
  await startNewGameFromHome(page, name);
}

/**
 * Save through the real NetHack command flow and wait for the next Home module.
 * @param page - running NetHack page.
 */
export async function saveAndReturnHome(page: Page): Promise<void> {
  await page.keyboard.press("S");
  await expect(page.getByText(/Really save/)).toBeVisible();
  await page.keyboard.press("y");
  await expect(page.getByText("--More--", { exact: true })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "New Game" })).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Quit an active game through NetHack's extended-command and end screens.
 * @param page - running NetHack page.
 */
export async function quitAndReturnHome(page: Page): Promise<void> {
  await page.keyboard.press("#");
  const commandDialog = page.getByRole("dialog", { name: "Extended command" });
  await expect(commandDialog).toBeVisible();
  const commandInput = commandDialog.locator("input");
  await commandInput.fill("quit");
  await commandInput.press("Enter");

  await expect(page.getByText(/Really quit without saving/)).toBeVisible();
  await page.keyboard.press("y");

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const homeButton = page.getByRole("button", { name: "New Game" });
    if (await homeButton.isVisible()) return;

    const disclosure = page.getByText(
      /Do you want (your possessions identified|to see)/,
    ).first();
    if (await disclosure.isVisible()) {
      await page.keyboard.press("q");
    } else if (await page.locator(".nh-text-dialog").isVisible()) {
      await page.keyboard.press("Enter");
    } else if (await page.getByText("--More--", { exact: true }).isVisible()) {
      await page.keyboard.press("Space");
    } else {
      await page.waitForTimeout(100);
    }
  }

  await expect(page.getByRole("button", { name: "New Game" })).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Open the save picker and select one validated character.
 * @param page - page showing the prepared Home screen.
 * @param name - validated character name shown by the picker.
 */
export async function continueSavedGame(
  page: Page,
  name: string,
): Promise<void> {
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Saved games" })).toBeVisible();
  await page.getByRole("button", {
    name: new RegExp(`^${name}\\b`),
  }).click();
}

/** Read the current player position from the rendered map cursor. */
export async function readCursorPosition(
  page: Page,
): Promise<CursorPosition> {
  const cursor = page.locator(".nh-cursor");
  await expect(cursor).toBeVisible();
  return {
    x: Number(await cursor.getAttribute("data-start")),
    y: Number(await cursor.locator("..").getAttribute("data-y")),
  };
}

/**
 * Move to an adjacent floor square without depending on dungeon randomness.
 * @param page - running NetHack page.
 * @returns cursor position after the movement completes.
 */
export async function moveToAdjacentFloor(
  page: Page,
): Promise<CursorPosition> {
  const cursor = page.locator(".nh-cursor");
  const { x: startX, y: startY } = await readCursorPosition(page);
  const rows = await page.locator(".nh-map-row").allTextContents();
  const directions = [
    { dx: -1, dy: 0, key: "ArrowLeft" },
    { dx: 1, dy: 0, key: "ArrowRight" },
    { dx: 0, dy: -1, key: "ArrowUp" },
    { dx: 0, dy: 1, key: "ArrowDown" },
  ];
  const direction = directions.find(
    ({ dx, dy }) => rows[startY + dy]?.[startX + dx] === ".",
  );

  expect(direction, "the initial room should have an adjacent floor").toBeTruthy();
  await page.keyboard.press(direction!.key);
  await expect.poll(async () => {
    const x = await cursor.getAttribute("data-start");
    const y = await cursor.locator("..").getAttribute("data-y");
    return `${x}:${y}`;
  }).not.toBe(`${startX}:${startY}`);
  return readCursorPosition(page);
}
