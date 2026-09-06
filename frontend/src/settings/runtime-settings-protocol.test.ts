import { describe, expect, it } from "vitest";
import {
  createDefaultProfile,
  NUMBER_PAD_MODES,
  PICKUP_CLASS_SYMBOLS,
} from "./profile";
import {
  decodeRuntimeSettings,
  encodeRuntimeSettings,
  runtimeSettingsFromProfile,
} from "./runtime-settings-protocol";

describe("runtime settings protocol", () => {
  it("round-trips every dynamic field and ignores tutorial", () => {
    const profile = createDefaultProfile().nethack;
    profile.tutorial = false;
    profile.autopickup = false;
    profile.pickupTypes = {
      mode: "selected",
      classes: ["_", "$", "?", "!"],
    };
    profile.numberPad = -1;
    profile.safePet = false;
    profile.sortpack = false;
    profile.showExperience = true;
    profile.showTime = true;

    const decoded = decodeRuntimeSettings(
      encodeRuntimeSettings(profile, true),
    );

    expect(decoded).toEqual({
      pending: true,
      settings: {
        autopickup: false,
        pickupTypes: {
          mode: "selected",
          classes: ["$", "?", "!", "_"],
        },
        numberPad: -1,
        safePet: false,
        sortpack: false,
        showExperience: true,
        showTime: true,
      },
    });
    expect(decoded.settings).toEqual(runtimeSettingsFromProfile(profile));
  });

  it.each(NUMBER_PAD_MODES)("round-trips number_pad %s", (numberPad) => {
    const settings = createDefaultProfile().nethack;
    settings.numberPad = numberPad;

    expect(
      decodeRuntimeSettings(encodeRuntimeSettings(settings, false))
        .settings.numberPad,
    ).toBe(numberPad);
  });

  it("round-trips every supported pickup class", () => {
    const settings = createDefaultProfile().nethack;
    settings.pickupTypes = {
      mode: "selected",
      classes: [...PICKUP_CLASS_SYMBOLS],
    };

    expect(
      decodeRuntimeSettings(encodeRuntimeSettings(settings, false))
        .settings.pickupTypes,
    ).toEqual(settings.pickupTypes);
  });

  it("distinguishes all pickup classes from an explicit selection", () => {
    const settings = createDefaultProfile().nethack;
    const all = decodeRuntimeSettings(
      encodeRuntimeSettings(settings, false),
    );
    settings.pickupTypes = {
      mode: "selected",
      classes: [...PICKUP_CLASS_SYMBOLS],
    };
    const selected = decodeRuntimeSettings(
      encodeRuntimeSettings(settings, false),
    );

    expect(all.settings.pickupTypes).toEqual({ mode: "all" });
    expect(selected.settings.pickupTypes).toEqual({
      mode: "selected",
      classes: [...PICKUP_CLASS_SYMBOLS],
    });
  });

  it.each([
    0,
    1 << 25,
    (1 << 28) | (6 << 7) | (1 << 6),
    (1 << 28) | (1 << 6) | (1 << 10),
    1 << 28,
  ])("rejects malformed payload %s", (payload) => {
    expect(() => decodeRuntimeSettings(payload)).toThrow();
  });
});
