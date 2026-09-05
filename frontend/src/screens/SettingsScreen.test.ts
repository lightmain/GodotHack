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
    onApply: (profile) => profile,
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

describe("SettingsScreen", () => {
  it("renders all reviewed fields and keeps the prepared module identity", () => {
    const html = renderSettings();

    expect(html).toContain('data-module-id="module-1"');
    expect(html).toMatch(/<h2[^>]*>Interface<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>NetHack<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Profile<\/h2>/);
    expect(html).toContain("Terminal font size");
    expect(html).toContain("Message history");
    expect(html).toContain("Follow player on the map");
    expect(html).toContain("Offer tutorial for new games");
    expect(html).toContain("Automatic pickup");
    expect(html).toContain("Pickup categories");
    expect(html).toContain("Movement keys");
    expect(html).toContain("Protect peaceful pets");
    expect(html).toContain("Sort inventory");
    expect(html).toContain("Show experience");
    expect(html).toContain("Show turn count");
  });

  it("starts clean with the reviewed defaults selected", () => {
    const html = renderSettings();

    expect(html).toMatch(/<input(?=[^>]*checked="")(?=[^>]*value="medium")[^>]*>/);
    expect(html).toMatch(/<input(?=[^>]*checked="")(?=[^>]*value="5")[^>]*>/);
    expect(html).toContain("<option value=\"0\" selected=\"\">");
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
});
