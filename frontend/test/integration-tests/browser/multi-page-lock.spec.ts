import { expect, test } from "./fixtures";
import { captureErrors } from "./helpers/browser-errors";
import {
  openHome,
  saveAndReturnHome,
  startNewGame,
} from "./helpers/game-flow";
import { openSavePicker } from "./helpers/save-flow";

const LOCK_DIALOG_NAME = "BlissHack is busy in another page";

test("blocks a second game and retries after the owning page closes", async ({
  context,
  page,
}) => {
  const errors = captureErrors(page);
  await openHome(page, "lock-owner-close");
  expect(await page.evaluate(() => typeof navigator.locks?.request))
    .toBe("function");
  await page.getByRole("button", { name: "New Game" }).click();
  await expect(page.getByRole("textbox", { name: "Who are you?" })).toBeVisible();

  const second = await context.newPage();
  const secondErrors = captureErrors(second);
  await openHome(second, "lock-waiter-close");
  await second.getByRole("button", { name: "Continue" }).click();
  let conflict = second.getByRole("alertdialog", {
    name: LOCK_DIALOG_NAME,
  });
  await expect(conflict).toBeVisible();
  await conflict.getByRole("button", { name: "Cancel" }).click();
  await expect(second.getByRole("heading", { name: "BlissHack" })).toBeVisible();
  await expect(second.getByRole("heading", {
    name: "BlissHack could not continue",
  })).toHaveCount(0);

  await second.getByRole("button", { name: "New Game" }).click();
  conflict = second.getByRole("alertdialog", {
    name: LOCK_DIALOG_NAME,
  });
  await expect(conflict).toBeVisible();
  await expect(conflict.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(second.getByRole("textbox", { name: "Who are you?" }))
    .toHaveCount(0);

  await page.close();
  await conflict.getByRole("button", { name: "Try Again" }).click();
  await expect(second.getByRole("textbox", { name: "Who are you?" }))
    .toBeVisible();
  await expect(conflict).toHaveCount(0);
  expect(errors).toEqual({ console: [], page: [] });
  expect(secondErrors).toEqual({ console: [], page: [] });
});

test("blocks save and profile exports while another page is playing", async ({
  context,
  page,
}) => {
  const errors = captureErrors(page);
  const name = "LockProtectedExport";
  await startNewGame(page, name);
  await saveAndReturnHome(page);

  const second = await context.newPage();
  const secondErrors = captureErrors(second);
  await openHome(second, "lock-protected-export");
  await openSavePicker(second);

  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page.locator(".nh-hp-bar")).toBeVisible();

  await second.getByRole("button", {
    name: `Export save ${name}`,
  }).click();
  let conflict = second.getByRole("alertdialog", {
    name: LOCK_DIALOG_NAME,
  });
  await expect(conflict).toBeVisible();
  await conflict.getByRole("button", { name: "Cancel" }).click();
  await expect(conflict).toHaveCount(0);

  await second.keyboard.press("Escape");
  await second.getByRole("button", { name: "Settings" }).click();
  await second.getByRole("button", { name: "Export Profile" }).click();
  conflict = second.getByRole("alertdialog", { name: LOCK_DIALOG_NAME });
  await expect(conflict).toBeVisible();
  await second.keyboard.press("Escape");
  await expect(conflict).toHaveCount(0);
  await expect(second.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(second.getByText("The profile could not be exported."))
    .toHaveCount(0);

  await second.getByRole("button", { name: "Export Full Backup" }).click();
  conflict = second.getByRole("alertdialog", { name: LOCK_DIALOG_NAME });
  await expect(conflict).toBeVisible();
  await conflict.getByRole("button", { name: "Cancel" }).click();
  await expect(second.getByText("The full backup could not be created."))
    .toHaveCount(0);
  expect(errors).toEqual({ console: [], page: [] });
  expect(secondErrors).toEqual({ console: [], page: [] });
});

test("releases the game lock after fatal session cleanup", async ({
  context,
  page,
}) => {
  const errors = captureErrors(page);
  await openHome(page, "lock-owner-fatal");
  await page.getByRole("button", { name: "New Game" }).click();
  await expect(page.getByRole("textbox", { name: "Who are you?" })).toBeVisible();

  const second = await context.newPage();
  const secondErrors = captureErrors(second);
  await openHome(second, "lock-waiter-fatal");
  await second.getByRole("button", { name: "New Game" }).click();
  const conflict = second.getByRole("alertdialog", {
    name: LOCK_DIALOG_NAME,
  });
  await expect(conflict).toBeVisible();

  await page.evaluate(() => {
    globalThis.setTimeout(() => {
      void Promise.reject(new Error("test fatal lock release"));
    }, 0);
  });
  await expect(
    page.getByRole("heading", { name: "BlissHack could not continue" }),
  ).toBeVisible();
  await conflict.getByRole("button", { name: "Try Again" }).click();
  await expect(second.getByRole("textbox", { name: "Who are you?" }))
    .toBeVisible();
  expect(errors.page).toEqual([]);
  expect(secondErrors).toEqual({ console: [], page: [] });
});

test("refreshes a stale Home save list after acquiring a short lock", async ({
  context,
  page,
}) => {
  await openHome(page, "stale-list-writer");
  const second = await context.newPage();
  await openHome(second, "stale-list-reader");
  const name = "CrossPageRefresh";

  await page.getByRole("button", { name: "New Game" }).click();
  const nameInput = page.getByRole("textbox", { name: "Who are you?" });
  await nameInput.fill(name);
  await nameInput.press("Enter");
  await expect(page.getByText(/Shall I pick character's/)).toBeVisible();
  await page.keyboard.press("y");
  await expect(page.getByRole("dialog", { name: "Is this ok? [ynq]" }))
    .toBeVisible();
  await page.keyboard.press("y");
  await expect(page.locator(".nh-text-dialog")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Do you want a tutorial?" }))
    .toBeVisible();
  await page.keyboard.press("n");
  await expect(page.locator(".nh-hp-bar")).toBeVisible();
  await saveAndReturnHome(page);

  const picker = await openSavePicker(second);
  await expect(picker.getByRole("button", {
    name: new RegExp(`^${name}\\b`),
  })).toBeVisible();
});

test("does not overwrite a profile changed by another idle page", async ({
  context,
  page,
}) => {
  await openHome(page, "stale-profile-first");
  const second = await context.newPage();
  await openHome(second, "stale-profile-second");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Small" }).check();
  await second.getByRole("button", { name: "Settings" }).click();
  await second.getByRole("radio", { name: "Large" }).check();
  await second.getByRole("button", { name: "Apply" }).click();
  await expect(second.getByRole("button", { name: "New Game" })).toBeVisible();

  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(
    "Settings changed in another page. Review your changes and try again.",
  )).toBeVisible();
  await expect(page.getByRole("radio", { name: "Small" })).toBeChecked();
  expect(await page.evaluate(() => {
    const raw = localStorage.getItem("blisshack.profile.v1");
    return raw ? JSON.parse(raw).interface.terminalFontSize : null;
  })).toBe("large");

  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("button", { name: "New Game" })).toBeVisible();
  expect(await page.evaluate(() => {
    const raw = localStorage.getItem("blisshack.profile.v1");
    return raw ? JSON.parse(raw).interface.terminalFontSize : null;
  })).toBe("small");
});

test("keeps the Settings draft baseline after exporting a newer profile", async ({
  context,
  page,
}) => {
  await openHome(page, "stale-profile-export-first");
  const second = await context.newPage();
  await openHome(second, "stale-profile-export-second");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Small" }).check();
  await second.getByRole("button", { name: "Settings" }).click();
  await second.getByRole("radio", { name: "Large" }).check();
  await second.getByRole("button", { name: "Apply" }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Profile" }).click();
  await downloadPromise;
  await page.getByRole("button", { name: "Apply" }).click();

  await expect(page.getByText(
    "Settings changed in another page. Review your changes and try again.",
  )).toBeVisible();
  expect(await page.evaluate(() => {
    const raw = localStorage.getItem("blisshack.profile.v1");
    return raw ? JSON.parse(raw).interface.terminalFontSize : null;
  })).toBe("large");
});

test("synchronizes an untouched Settings draft after exporting a newer profile", async ({
  context,
  page,
}) => {
  await openHome(page, "clean-profile-export-first");
  const second = await context.newPage();
  await openHome(second, "clean-profile-export-second");

  await page.getByRole("button", { name: "Settings" }).click();
  await second.getByRole("button", { name: "Settings" }).click();
  await second.getByRole("radio", { name: "Large" }).check();
  await second.getByRole("button", { name: "Apply" }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Profile" }).click();
  await downloadPromise;

  await expect(page.getByRole("radio", { name: "Large" })).toBeChecked();
  await expect(page.getByText("No unsaved changes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
});

test("advances the Settings baseline when an external profile matches the draft", async ({
  context,
  page,
}) => {
  await openHome(page, "matching-profile-export-first");
  const second = await context.newPage();
  await openHome(second, "matching-profile-export-second");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Large" }).check();
  await second.getByRole("button", { name: "Settings" }).click();
  await second.getByRole("radio", { name: "Large" }).check();
  await second.getByRole("button", { name: "Apply" }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Profile" }).click();
  await downloadPromise;
  await expect(page.getByText("No unsaved changes")).toBeVisible();

  await page.getByRole("radio", { name: "Small" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("button", { name: "New Game" })).toBeVisible();
  expect(await page.evaluate(() => {
    const raw = localStorage.getItem("blisshack.profile.v1");
    return raw ? JSON.parse(raw).interface.terminalFontSize : null;
  })).toBe("small");
});

test("advances the Settings baseline after a draft manually matches an external profile", async ({
  context,
  page,
}) => {
  await openHome(page, "converged-profile-export-first");
  const second = await context.newPage();
  await openHome(second, "converged-profile-export-second");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Small" }).check();
  await second.getByRole("button", { name: "Settings" }).click();
  await second.getByRole("radio", { name: "Large" }).check();
  await second.getByRole("button", { name: "Apply" }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Profile" }).click();
  await downloadPromise;
  await page.getByRole("radio", { name: "Large" }).check();
  await expect(page.getByText("No unsaved changes")).toBeVisible();

  await page.getByRole("radio", { name: "Small" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("button", { name: "New Game" })).toBeVisible();
  expect(await page.evaluate(() => {
    const raw = localStorage.getItem("blisshack.profile.v1");
    return raw ? JSON.parse(raw).interface.terminalFontSize : null;
  })).toBe("small");
});

test("keeps single-page play and profile storage available without Web Locks", async ({
  page,
}) => {
  const errors = captureErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "locks", {
      configurable: true,
      get: () => undefined,
    });
  });
  await page.goto("?integration=no-web-locks");
  await expect(page.getByText(
    "This browser cannot protect games opened in multiple BlissHack pages.",
  )).toBeVisible();
  await expect(page.getByRole("button", { name: "New Game" })).toBeEnabled();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Large" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("button", { name: "New Game" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("radio", { name: "Large" })).toBeChecked();
  await page.getByRole("button", { name: "Back to Home" }).click();

  await page.getByRole("button", { name: "New Game" }).click();
  await expect(page.getByRole("textbox", { name: "Who are you?" })).toBeVisible();
  expect(errors).toEqual({ console: [], page: [] });
});

test("reports a browser lock request failure without starting a session", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "locks", {
      configurable: true,
      get: () => ({
        request: async () => {
          throw new DOMException("Lock manager failed", "InvalidStateError");
        },
      }),
    });
  });
  await page.goto("?integration=web-lock-request-failure");
  await page.getByRole("button", { name: "New Game" }).click();

  const dialog = page.getByRole("alertdialog", {
    name: "BlissHack could not coordinate browser pages",
  });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Who are you?" }))
    .toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "New Game" })).toBeVisible();
  await expect(page.getByRole("heading", {
    name: "BlissHack could not continue",
  })).toHaveCount(0);
});
