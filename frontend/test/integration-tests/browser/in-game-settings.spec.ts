import { expect, test } from "./fixtures";
import { captureErrors } from "./helpers/browser-errors";
import { startNewGame } from "./helpers/game-flow";

test("pauses only at command input and synchronizes in-game settings", async ({
  page,
}) => {
  const errors = captureErrors(page);
  await startNewGame(page, "PauseSettings");

  await page.keyboard.press("Escape");
  const pause = page.getByRole("dialog", { name: "Game paused" });
  await expect(pause).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume" })).toBeFocused();

  await page.getByRole("button", { name: "Resume" }).click();
  await page.keyboard.press("Alt+u");
  await expect(page.getByText("In what direction?", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pause).toHaveCount(0);
  await expect(page.getByText("In what direction?", { exact: true })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to Pause" })).toBeVisible();
  await page.getByRole("radio", { name: "Large" }).check();
  await page.getByRole("checkbox", { name: "Show turn count" }).check();
  await page.getByRole("button", { name: "Apply" }).click();

  await expect(pause).toBeVisible();
  await expect(page.locator(".nh-shell")).toHaveClass(/nh-font-large/);
  await expect(page.locator(".nh-status")).toContainText(/T:\d+/);
  const resume = page.getByRole("button", { name: "Resume" });
  await expect(page.locator(".nh-shell")).toHaveAttribute(
    "data-settings-status",
    "applied",
  );
  await expect(resume).toBeEnabled();
  await resume.click();
  await expect(pause).toHaveCount(0);
  await expect(page.locator(".nh-shell")).toHaveAttribute(
    "data-command-input",
    "ready",
  );

  await page.keyboard.press("Shift+Digit2");
  await expect(page.locator(".nh-messages")).toContainText("Autopickup: OFF.");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(
    page.getByRole("checkbox", { name: "Automatic pickup" }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Save and Exit" }).click();
  await expect(page.getByText(/Really save/)).toBeVisible();
  await page.keyboard.press("y");
  await expect(page.getByText("--More--", { exact: true })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "New Game" })).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("radio", { name: "Large" })).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Automatic pickup" }),
  ).not.toBeChecked();
  expect(errors).toEqual({ console: [], page: [] });
});
