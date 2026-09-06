import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProfileProvider } from "./ProfileProvider";
import { useProfileSettings } from "./profile-context";
import {
  PROFILE_STORAGE_KEY,
  type ProfileStorage,
} from "./profile-store";
import { createDefaultProfile } from "./profile";

function ProfileProbe() {
  const { loadStatus, profile } = useProfileSettings();
  return createElement(
    "output",
    null,
    [
      loadStatus,
      profile.interface.terminalFontSize,
      profile.interface.messageHistoryLines,
      String(profile.interface.followPlayer),
    ].join(":"),
  );
}

describe("ProfileProvider", () => {
  it("provides one validated persisted profile to its child tree", () => {
    const profile = createDefaultProfile();
    profile.interface.terminalFontSize = "large";
    profile.interface.messageHistoryLines = 3;
    profile.interface.followPlayer = false;
    const storage: ProfileStorage = {
      getItem: vi.fn((key: string) =>
        key === PROFILE_STORAGE_KEY ? JSON.stringify(profile) : null),
      setItem: vi.fn(),
    };

    const html = renderToStaticMarkup(createElement(
      ProfileProvider,
      { storage },
      createElement(ProfileProbe),
    ));

    expect(html).toContain("loaded:large:3:false");
  });

  it("exposes the unavailable fallback state without writing defaults", () => {
    const storage: ProfileStorage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(),
    };

    const html = renderToStaticMarkup(createElement(
      ProfileProvider,
      { storage },
      createElement(ProfileProbe),
    ));

    expect(html).toContain("unavailable:medium:5:true");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("fails clearly when a consumer is outside the provider", () => {
    expect(() => renderToStaticMarkup(createElement(ProfileProbe)))
      .toThrow(/ProfileProvider/);
  });
});
