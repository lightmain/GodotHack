import { expect, test } from "./fixtures";
import { captureErrors } from "./helpers/browser-errors";
import {
  continueSavedGame,
  openHome,
  saveAndReturnHome,
  startNewGame,
} from "./helpers/game-flow";
import {
  exportSave,
  openSavePicker,
  readDownload,
} from "./helpers/save-flow";

test("exports, clears, and restores a complete BlissHack backup", async ({
  page,
}) => {
  const errors = captureErrors(page);
  const name = "E2EFullBackup";
  await startNewGame(page, name);
  await saveAndReturnHome(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Large" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("button", { name: "Settings" }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Full Backup" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^blisshack-backup-.+\.bhbackup$/,
  );
  const backupBytes = await readDownload(download);
  const backup = JSON.parse(backupBytes.toString("utf8")) as {
    format: string;
    schemaVersion: number;
    profile: { interface: { terminalFontSize: string } };
    saves: Array<{
      fileName: string;
      byteLength: number;
      sha256: string;
      data: string;
    }>;
  };
  expect(backup).toMatchObject({
    format: "blisshack-backup",
    schemaVersion: 1,
    profile: { interface: { terminalFontSize: "large" } },
  });
  expect(backup.saves).toHaveLength(1);
  expect(backup.saves[0].fileName).toBe(`0${name}`);
  expect(Buffer.from(backup.saves[0].data, "base64")).toHaveLength(
    backup.saves[0].byteLength,
  );
  expect(backup.saves[0].sha256).toMatch(/^[0-9a-f]{64}$/);

  const diagnosticCount = await page.evaluate(() => {
    const raw = localStorage.getItem("blisshack.diagnostics.v1");
    if (!raw) return 0;
    return (JSON.parse(raw) as { events?: unknown[] }).events?.length ?? 0;
  });
  await page.getByRole("button", { name: "Clear Local Data" }).click();
  const clear = page.getByRole("alertdialog", { name: "Clear local data" });
  await expect(clear.getByRole("textbox")).toBeFocused();
  await expect(clear).toContainText(`${diagnosticCount} diagnostic events`);
  await clear.getByRole("textbox").fill("CLEAR BLISSHACK DATA");
  await clear.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByRole("button", { name: "New Game" })).toBeVisible();
  expect(await page.evaluate(() =>
    localStorage.getItem("blisshack.profile.v1"))).toBeNull();

  const emptyPicker = await openSavePicker(page);
  await expect(emptyPicker.getByText("No saved games")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Import full backup file").setInputFiles({
    name: "restore.bhbackup",
    mimeType: "application/json",
    buffer: backupBytes,
  });
  const preview = page.getByRole("dialog", { name: "Import full backup" });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(preview.getByText("Terminal font size")).toBeVisible();
  await expect(preview.getByText(name, { exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "Import Saves" }).click();

  const results = page.getByRole("dialog", { name: "Backup import results" });
  await expect(results.getByText("1 imported")).toBeVisible();
  await expect(results.getByText("0 skipped")).toBeVisible();
  await expect(results.getByText("0 failed")).toBeVisible();
  await results.getByRole("button", { name: "Apply Profile" }).click();
  await expect(results.getByText("Profile applied")).toBeVisible();
  await results.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", {
    name: "Import Full Backup",
    exact: true,
  }))
    .toBeFocused();
  await expect(page.getByRole("radio", { name: "Large" })).toBeChecked();
  await page.getByRole("button", { name: "Back to Home" }).click();

  await continueSavedGame(page, name);
  await expect(page.getByLabel(new RegExp(`${name} the .+, \\d+% HP`)))
    .toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual({ console: [], page: [] });
});

test("exports the exact bytes of an incompatible formal save", async ({
  page,
}) => {
  const errors = captureErrors(page);
  const sourceName = "E2ERescueSource";
  const rescueName = "E2ERescue";
  await startNewGame(page, sourceName);
  await saveAndReturnHome(page);
  await openSavePicker(page);
  const compatible = await exportSave(page, sourceName);
  await page.keyboard.press("Escape");

  const incompatible = Buffer.from(compatible);
  incompatible[0] ^= 0xff;
  await page.evaluate(async ({ sourcePath, targetPath, bytes }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("/save", 21);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("FILE_DATA", "readwrite");
        const store = transaction.objectStore("FILE_DATA");
        const getRequest = store.get(sourcePath);
        getRequest.onerror = () => reject(getRequest.error);
        getRequest.onsuccess = () => {
          const source = getRequest.result as {
            mode: number;
            timestamp: Date;
          };
          store.put({
            mode: source.mode,
            timestamp: new Date(),
            contents: new Uint8Array(bytes),
          }, targetPath);
        };
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, {
    sourcePath: `/save/0${sourceName}`,
    targetPath: `/save/0${rescueName}`,
    bytes: [...incompatible],
  });

  await page.reload();
  const picker = await openSavePicker(page);
  const unavailable = picker.getByRole("button", {
    name: new RegExp(`^${rescueName}\\b`),
  });
  await expect(unavailable).toBeDisabled();
  await expect(unavailable).toContainText(/incompatible.*build/i);

  const downloadPromise = page.waitForEvent("download");
  await picker.getByRole("button", {
    name: `Export save ${rescueName}`,
    exact: true,
  }).click();
  const rescued = await readDownload(await downloadPromise);
  expect(rescued).toEqual(incompatible);
  expect(errors).toEqual({ console: [], page: [] });
});

test("restores data-action focus after recoverable failures", async ({
  page,
}) => {
  await openHome(page, "backup-error-focus");
  await page.getByRole("button", { name: "Settings" }).click();

  await page.getByLabel("Import full backup file").setInputFiles({
    name: "invalid.bhbackup",
    mimeType: "application/json",
    buffer: Buffer.from("{bad"),
  });
  const importError = page.getByText(
    "The selected backup is damaged, unsupported, or invalid.",
  );
  await expect(importError).toHaveAttribute("id", "data-operation-error");
  const importButton = page.getByRole("button", {
    name: "Import Full Backup",
    exact: true,
  });
  await expect(importButton).toHaveAttribute(
    "aria-describedby",
    "data-operation-error",
  );
  await expect(page.getByLabel("Import full backup file"))
    .toHaveAttribute("aria-invalid", "true");
  await expect(importButton).toBeFocused();

  await page.evaluate(() => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function failOnce(key: string): void {
      Storage.prototype.removeItem = original;
      throw new Error(`blocked ${key}`);
    };
  });
  await page.getByRole("button", { name: "Clear Local Data" }).click();
  const clear = page.getByRole("alertdialog", { name: "Clear local data" });
  await clear.getByRole("textbox").fill("CLEAR BLISSHACK DATA");
  await clear.getByRole("button", { name: "Clear", exact: true }).click();

  const clearError = page.getByText(
    "Local data could not be cleared. Existing data was preserved when possible.",
  );
  await expect(clearError).toHaveAttribute("id", "data-operation-error");
  const clearButton = page.getByRole("button", { name: "Clear Local Data" });
  await expect(clearButton).toHaveAttribute(
    "aria-describedby",
    "data-operation-error",
  );
  await expect(clearButton).toBeFocused();
});
