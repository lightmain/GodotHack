import { expect, test } from "./fixtures";
import { captureErrors } from "./helpers/browser-errors";
import { exportDiagnosticLog } from "./helpers/diagnostic-artifact";
import {
  startNewGame,
  startNewGameFromHome,
} from "./helpers/game-flow";

test("shows a fatal page and exports a private diagnostic log", async ({
  page,
}) => {
  const playerName = "E2E_Private_Diagnostic";
  const privateMessage = `${playerName} pressed Control+p near a secret door`;
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await startNewGame(page, playerName);

  await page.evaluate((message) => {
    globalThis.setTimeout(() => {
      void Promise.reject(new Error(message));
    }, 0);
  }, privateMessage);

  await expect(
    page.getByRole("heading", { name: "BlissHack could not continue" }),
  ).toBeVisible();
  const errorId = await page.locator(".fatal-screen code").textContent();
  expect(errorId).toMatch(/^BH-[A-Z0-9]{8}$/);
  await expect(
    page.getByRole("button", { name: "Reload Application" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Return Home" })).toHaveCount(0);

  const { diagnostic, text } = await exportDiagnosticLog(page);
  expect(diagnostic.schemaVersion).toBe(1);
  expect(diagnostic.productVersion).toBe("prealpha-4");
  expect(diagnostic.buildId).toBeTruthy();
  expect(diagnostic.events).toContainEqual(expect.objectContaining({
    event: "app.started",
    detail: { buildId: diagnostic.buildId },
  }));
  expect(diagnostic.events).toContainEqual(expect.objectContaining({
    level: "fatal",
    event: "browser.unhandled_rejection",
    errorId,
  }));
  expect(text).not.toContain(playerName);
  expect(text).not.toContain("Control+p");
  expect(text).not.toContain("secret door");
  expect(consoleErrors).toContain(
    `[BlissHack][fatal][${errorId}] browser.unhandled_rejection`,
  );
  expect(consoleErrors.join("\n")).not.toContain(privateMessage);
});

test("shows a recoverable module fatal page when the loader returns 404", async ({
  page,
}) => {
  await page.route("**/nethack.js", (route) =>
    route.fulfill({
      status: 404,
      contentType: "text/javascript",
      body: "",
    }));
  await page.goto("?integration=missing-loader");

  await expect(
    page.getByRole("heading", { name: "BlissHack could not continue" }),
  ).toBeVisible();
  const errorId = await page.locator(".fatal-screen code").textContent();
  expect(errorId).toMatch(/^BH-[A-Z0-9]{8}$/);
  await expect(page.getByRole("button", { name: "Return Home" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reload Application" }),
  ).toHaveCount(0);

  const { diagnostic } = await exportDiagnosticLog(page);
  expect(diagnostic.events).toContainEqual(expect.objectContaining({
    level: "fatal",
    event: "module.loading_failed",
    errorId,
  }));
});

test("allows a temporary new game when IndexedDB is unavailable", async ({
  page,
}) => {
  const errors = captureErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("?integration=no-indexeddb");

  await expect(page.getByText(
    "Persistent storage is unavailable. New games are temporary.",
  )).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "New Game" })).toBeEnabled();
  await startNewGameFromHome(page, "E2E_Temporary");
  await expect(page.getByLabel(/E2E_Temporary the .+, 100% HP/)).toBeVisible();
  expect(errors).toEqual({ console: [], page: [] });
});
