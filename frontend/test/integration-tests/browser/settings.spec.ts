import { expect, test } from "./fixtures";
import { captureErrors } from "./helpers/browser-errors";
import { openHome } from "./helpers/game-flow";
import { openSavePicker, readDownload } from "./helpers/save-flow";

test("edits, persists, and cancels Home Settings without replacing the module", async ({
  page,
}) => {
  const errors = captureErrors(page);
  await openHome(page, "settings-edit");
  const picker = await openSavePicker(page);
  const moduleId = await picker.getAttribute("data-module-id");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Settings" }).click();
  const screen = page.locator(".settings-screen");
  await expect(screen).toHaveAttribute("data-module-id", moduleId!);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Medium" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "5 lines" })).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Contents" })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "Right" })).toBeDisabled();
  await expect(
    page.getByRole("checkbox", { name: "Start collapsed" }),
  ).toBeDisabled();

  await page.getByRole("radio", { name: "Large" }).check();
  await page.getByRole("radio", { name: "3 lines" }).check();
  await page.getByRole("checkbox", {
    name: "Follow player on the map",
  }).uncheck();
  await page.getByRole("checkbox", {
    name: "Offer tutorial for new games",
  }).uncheck();
  await page.getByRole("checkbox", { name: "Show experience" }).check();
  await page.getByRole("checkbox", { name: "Show turn count" }).check();
  await page.getByRole("checkbox", {
    name: "Enable Permanent Inventory",
    exact: true,
  }).check();
  await page.getByRole("combobox", { name: "Contents" }).selectOption("full");
  await page.getByRole("radio", { name: "Below" }).check();
  await page.getByRole("checkbox", { name: "Start collapsed" }).check();
  await page.getByRole("combobox", { name: "Movement keys" })
    .selectOption("-1");
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply" }).click();

  await expect(page.getByRole("button", { name: "New Game" })).toBeVisible();
  const sameModulePicker = await openSavePicker(page);
  await expect(sameModulePicker).toHaveAttribute("data-module-id", moduleId!);
  await page.keyboard.press("Escape");
  const persisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("blisshack.profile.v1") ?? "null"));
  expect(persisted).toMatchObject({
    interface: {
      terminalFontSize: "large",
      messageHistoryLines: 3,
      followPlayer: false,
      permanentInventoryPosition: "below",
      permanentInventoryCollapsed: true,
    },
    nethack: {
      tutorial: false,
      numberPad: -1,
      showExperience: true,
      showTime: true,
      permInvent: true,
      perminvMode: "full",
    },
  });

  await page.reload();
  const reloadedPicker = await openSavePicker(page);
  const reloadedModuleId = await reloadedPicker.getAttribute("data-module-id");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("radio", { name: "Large" })).toBeChecked();
  await page.getByRole("radio", { name: "Small" }).check();
  await page.getByRole("button", { name: "Back to Home" }).click();
  const discard = page.getByRole("alertdialog", { name: "Unsaved settings" });
  await expect(discard).toBeVisible();
  await expect(screen).toHaveAttribute("inert", "");
  const discardCancel = discard.getByRole("button", { name: "Cancel" });
  const discardConfirm = discard.getByRole("button", { name: "Discard" });
  await expect(discardCancel).toBeFocused();
  await discardConfirm.focus();
  await page.keyboard.press("Tab");
  await expect(discardCancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(discardConfirm).toBeFocused();
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to Home" })).toBeFocused();
  await page.getByRole("button", { name: "Back to Home" }).click();
  await page.getByRole("alertdialog", { name: "Unsaved settings" })
    .getByRole("button", { name: "Discard" }).click();

  const sameReloadedModulePicker = await openSavePicker(page);
  await expect(sameReloadedModulePicker)
    .toHaveAttribute("data-module-id", reloadedModuleId!);
  expect(errors).toEqual({ console: [], page: [] });
});

test("exports, previews, imports, and restores a complete profile", async ({
  page,
}) => {
  const errors = captureErrors(page);
  await openHome(page, "settings-transfer");
  await page.getByRole("button", { name: "Settings" }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Profile" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("blisshack-profile.bhprofile");
  const exported = JSON.parse((await readDownload(download)).toString("utf8"));
  expect(exported).toMatchObject({
    schemaVersion: 1,
    productVersion: "prealpha-3",
  });

  exported.interface.terminalFontSize = "large";
  exported.nethack.autopickup = false;
  exported.nethack.pickupTypes = {
    mode: "selected",
    classes: ["$", "?", "!"],
  };
  await page.getByLabel("Import profile file").setInputFiles({
    name: "custom.bhprofile",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exported)),
  });

  const preview = page.getByRole("dialog", { name: "Import profile" });
  await expect(preview).toBeVisible();
  await expect(page.locator(".settings-screen")).toHaveAttribute("inert", "");
  await expect(preview.getByText("Terminal font size")).toBeVisible();
  await expect(preview.getByText("Automatic pickup")).toBeVisible();
  await expect(preview.getByText("Pickup categories")).toBeVisible();
  const previewCancel = preview.getByRole("button", { name: "Cancel" });
  const previewImport = preview.getByRole("button", { name: "Import" });
  await expect(previewCancel).toBeFocused();
  await previewImport.focus();
  await page.keyboard.press("Tab");
  await expect(previewCancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole("button", {
    name: "Import Profile",
    exact: true,
  })).toBeFocused();

  await page.getByLabel("Import profile file").setInputFiles({
    name: "custom.bhprofile",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText("Profile imported", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Large" })).toBeChecked();
  await expect(page.getByRole("checkbox", {
    name: "Automatic pickup",
  })).not.toBeChecked();

  await page.getByRole("button", { name: "Restore Defaults" }).click();
  const restore = page.getByRole("alertdialog", { name: "Restore defaults" });
  await expect(restore).toBeVisible();
  await restore.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Defaults restored", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Medium" })).toBeChecked();
  await expect(page.getByRole("checkbox", {
    name: "Automatic pickup",
  })).toBeChecked();

  const restored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("blisshack.profile.v1") ?? "null"));
  expect(restored).toMatchObject({
    interface: {
      terminalFontSize: "medium",
      messageHistoryLines: 5,
      followPlayer: true,
    },
    nethack: {
      autopickup: true,
      pickupTypes: { mode: "all" },
    },
  });

  const profileInput = page.getByLabel("Import profile file");
  await profileInput.setInputFiles({
    name: "invalid.bhprofile",
    mimeType: "application/json",
    buffer: Buffer.from("{bad"),
  });
  const importError = page.getByText(
    "The selected profile is damaged, unsupported, or invalid.",
  );
  await expect(importError).toHaveAttribute("id", "settings-error");
  await expect(profileInput).toHaveAttribute(
    "aria-describedby",
    "settings-error",
  );
  await expect(profileInput).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", {
    name: "Import Profile",
    exact: true,
  }))
    .toHaveAttribute("aria-describedby", "settings-error");
  expect(errors).toEqual({ console: [], page: [] });
});
