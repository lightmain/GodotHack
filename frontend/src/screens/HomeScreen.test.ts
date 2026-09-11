import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HomeScreen } from "./HomeScreen";

interface StageTwoHomeProps {
  hasSaves: boolean;
  onContinue: () => void;
  onContinueSave?: (save: unknown) => void;
  onDismissSavePicker?: () => void;
  onNewGame: () => void;
  savePickerOpen?: boolean;
  saves?: Array<{
    path: string;
    status: "ready";
    identity: { playerName: string };
  }>;
  storageAvailable: boolean;
}

/**
 * Return the opening button tag whose accessible text matches a label.
 * @param html - server-rendered HomeScreen markup.
 * @param label - visible button label.
 * @returns the complete button element.
 */
function buttonMarkup(html: string, label: string): string {
  const match = html.match(
    new RegExp(`<button[^>]*>\\s*${label}\\s*</button>`, "i"),
  );
  expect(match, `missing ${label} button`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("HomeScreen", () => {
  it("renders the product identity and required footer information", () => {
    const html = renderToStaticMarkup(createElement(HomeScreen, {
      onNewGame: vi.fn(),
    }));

    expect(html).toMatch(/<h1[^>]*>\s*BlissHack\s*<\/h1>/i);
    expect(html).toMatch(/NetHack\s*5\.0/i);
    expect(html).toMatch(/unofficial|非官方/i);
    expect(html).toMatch(/<footer[\s\S]*BlissHack[\s\S]*copyright/i);
    expect(html).toMatch(/<a[^>]+href=[^>]+>[^<]*licen[cs]e[^<]*<\/a>/i);
    expect(html.match(/prealpha-4/g)).toHaveLength(2);
  });

  it("does not start a session while rendering the home screen", () => {
    const startSession = vi.fn();

    renderToStaticMarkup(createElement(HomeScreen, {
      onNewGame: startSession,
    }));

    expect(startSession).not.toHaveBeenCalled();
  });

  it("renders New Game, Continue, and Settings in command order", () => {
    const html = renderToStaticMarkup(createElement(HomeScreen, {
      onNewGame: vi.fn(),
    }));
    const newGameIndex = html.indexOf(">New Game<");
    const continueIndex = html.indexOf(">Continue<");
    const settingsIndex = html.indexOf(">Settings<");

    expect(newGameIndex).toBeGreaterThan(-1);
    expect(continueIndex).toBeGreaterThan(newGameIndex);
    expect(settingsIndex).toBeGreaterThan(continueIndex);
  });

  it("keeps all Home commands enabled when storage is available", () => {
    const html = renderToStaticMarkup(createElement(HomeScreen, {
      onNewGame: vi.fn(),
    }));

    expect(buttonMarkup(html, "New Game")).not.toMatch(/\sdisabled(?:=|>)/i);
    expect(buttonMarkup(html, "Continue")).not.toMatch(/\sdisabled(?:=""|>)/i);
    expect(buttonMarkup(html, "Settings")).not.toMatch(/\sdisabled(?:=""|>)/i);
  });

  it("enables Continue with persistent storage even when import is the only action", () => {
    const StageTwoHome = HomeScreen as ComponentType<StageTwoHomeProps>;
    const enabled = renderToStaticMarkup(createElement(StageTwoHome, {
      hasSaves: true,
      onContinue: vi.fn(),
      onNewGame: vi.fn(),
      storageAvailable: true,
    }));
    const noSaves = renderToStaticMarkup(createElement(StageTwoHome, {
      hasSaves: false,
      onContinue: vi.fn(),
      onNewGame: vi.fn(),
      storageAvailable: true,
    }));

    expect(buttonMarkup(enabled, "Continue")).not.toMatch(
      /\sdisabled(?:=""|>)/i,
    );
    expect(buttonMarkup(noSaves, "Continue")).not.toMatch(
      /\sdisabled(?:=""|>)/i,
    );
  });

  it("keeps New Game available but warns and disables Continue without IDBFS", () => {
    const StageTwoHome = HomeScreen as ComponentType<StageTwoHomeProps>;
    const html = renderToStaticMarkup(createElement(StageTwoHome, {
      hasSaves: true,
      onContinue: vi.fn(),
      onNewGame: vi.fn(),
      storageAvailable: false,
    }));

    expect(buttonMarkup(html, "New Game")).not.toMatch(/\sdisabled(?:=""|>)/i);
    expect(buttonMarkup(html, "Continue")).toMatch(/\sdisabled(?:=""|>)/i);
    expect(html).toMatch(/storage|persist|IndexedDB|存档/i);
  });

  it("renders the save picker as a Continue popover inside home", () => {
    const StageTwoHome = HomeScreen as ComponentType<StageTwoHomeProps>;
    const html = renderToStaticMarkup(createElement(StageTwoHome, {
      hasSaves: true,
      onContinue: vi.fn(),
      onContinueSave: vi.fn(),
      onDismissSavePicker: vi.fn(),
      onNewGame: vi.fn(),
      savePickerOpen: true,
      saves: [{
        path: "/save/0Ada",
        status: "ready",
        identity: { playerName: "Ada" },
      }],
      storageAvailable: true,
    }));

    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toMatch(/aria-expanded="true"/);
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-label="Saved games"/);
    expect(html).toMatch(/Ada/);
    expect(html).not.toMatch(/>\s*Back\s*</);
  });
});
