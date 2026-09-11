import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createDefaultProfile } from "../settings/profile";
import type { ProfileLoadStatus } from "../settings/profile-store";
import { SettingsScreen } from "./SettingsScreen";

function renderSettings(loadStatus: ProfileLoadStatus = "loaded"): string {
  return renderToStaticMarkup(createElement(SettingsScreen, {
    loadStatus,
    moduleId: "module-1",
    onApply: async (profile) => profile,
    onBack: vi.fn(),
    profile: createDefaultProfile(),
  }));
}

function buttonMarkup(html: string, label: string): string {
  const match = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gi)]
    .map((entry) => entry[0])
    .find((button) => button.includes(label));
  expect(match, `missing ${label} button`).toBeDefined();
  return match ?? "";
}

function labelMarkup(html: string, text: string): string {
  const match = [...html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gi)]
    .map((entry) => entry[0])
    .find((label) => label.includes(text));
  expect(match, `missing ${text} field`).toBeDefined();
  return match ?? "";
}

describe("SettingsScreen", () => {
  it("renders all reviewed fields and keeps the prepared module identity", () => {
    const html = renderSettings();

    expect(html).toContain('data-module-id="module-1"');
    expect(html).toMatch(/<h2[^>]*>Interface<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Inventory<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>NetHack<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Profile<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Data<\/h2>/);
    expect(html).toContain("Terminal font size");
    expect(html).toContain("Message history");
    expect(html).toContain("Follow player on the map");
    expect(html).toContain("Status display");
    expect(html).toContain("Preferred position");
    expect(html).not.toContain("Inventory width");
    expect(html).toContain("Start collapsed");
    expect(html).toContain("Offer tutorial for new games");
    expect(html).toContain("Automatic pickup");
    expect(html).toContain("Pickup categories");
    expect(html).toContain("Movement keys");
    expect(html).toContain("Protect peaceful pets");
    expect(html).toContain("Sort inventory");
    expect(html).toContain("Show experience");
    expect(html).toContain("Show turn count");
    expect(html).toContain("Permanent inventory");
    expect(html).toContain("Contents");
    expect(html).toContain("All except gold");
    expect(html).toContain("Full including gold");
    expect(html).toContain("Items in use");
    expect(html).toContain("Export Full Backup");
    expect(html).toContain("Import Full Backup");
    expect(html).toContain("Clear Local Data");
  });

  it("starts clean with the reviewed defaults selected", () => {
    const html = renderSettings();

    expect(html).toMatch(/<input(?=[^>]*checked="")(?=[^>]*value="medium")[^>]*>/);
    expect(html).toMatch(/<input(?=[^>]*checked="")(?=[^>]*value="5")[^>]*>/);
    expect(html).toContain("<option value=\"0\" selected=\"\">");
    expect(html).toMatch(/<input(?=[^>]*checked="")(?=[^>]*value="right")[^>]*>/);
    expect(labelMarkup(html, "Permanent inventory")).not.toContain("checked");
    expect(html).toContain('<option value="all" selected="">');
    expect(labelMarkup(html, "Contents")).toContain("disabled");
    expect(labelMarkup(html, "Start collapsed")).toContain("disabled");
    expect(labelMarkup(html, "Start collapsed")).not.toContain("checked");
    expect(html).toMatch(
      /<input(?=[^>]*disabled="")(?=[^>]*value="right")[^>]*>/,
    );
    expect(html).toContain("No unsaved changes");
    expect(buttonMarkup(html, "Apply")).toMatch(/\sdisabled(?:=""|>)/i);
  });

  it("disables persistence actions and shows a warning when storage is unavailable", () => {
    const html = renderSettings("unavailable");

    expect(html).toMatch(/storage is unavailable/i);
    expect(buttonMarkup(html, "Import Profile"))
      .toMatch(/\sdisabled(?:=""|>)/i);
    expect(buttonMarkup(html, "Restore Defaults"))
      .toMatch(/\sdisabled(?:=""|>)/i);
    expect(buttonMarkup(html, "Apply")).toMatch(/\sdisabled(?:=""|>)/i);
    expect(buttonMarkup(html, "Export Profile"))
      .not.toMatch(/\sdisabled(?:=""|>)/i);
  });

  it.each([
    ["invalid", /could not be read/i],
    ["unsupported-schema", /unsupported version/i],
  ] satisfies Array<[ProfileLoadStatus, RegExp]>)(
    "reports the %s profile recovery state",
    (status, message) => {
      expect(renderSettings(status)).toMatch(message);
    },
  );

  it("reuses the settings fields without profile transfer actions in game", () => {
    const html = renderToStaticMarkup(createElement(SettingsScreen, {
      context: "game",
      loadStatus: "loaded",
      moduleId: "module-1",
      onApply: async (profile) => profile,
      onBack: vi.fn(),
      profile: createDefaultProfile(),
    }));

    expect(html).toContain("Current game and future defaults");
    expect(html).toContain('aria-label="Back to Pause"');
    expect(html).not.toContain("<h2 id=\"profile-title\">Profile</h2>");
    expect(html).not.toContain("Import Profile");
    expect(html).not.toContain("Export Profile");
    expect(html).not.toContain("Export Full Backup");
    expect(html).not.toContain("Clear Local Data");
    expect(html).toContain("Permanent inventory");
    expect(html).toContain("Contents");
  });
});
