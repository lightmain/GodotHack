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
        permInvent: false,
        perminvMode: "all",
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

  it.each(["all", "full", "in-use"] as const)(
    "round-trips enabled permanent inventory mode %s in protocol 2",
    (perminvMode) => {
      const settings = createDefaultProfile().nethack;
      settings.permInvent = true;
      settings.perminvMode = perminvMode;

      const payload = encodeRuntimeSettings(settings, false);

      expect((payload >>> 28) & 0b111).toBe(2);
      expect(decodeRuntimeSettings(payload).settings).toMatchObject({
        permInvent: true,
        perminvMode,
      });
    },
  );

  it("normalizes the core none mode to a disabled all-mode profile value", () => {
    const encoded = encodeRuntimeSettings(createDefaultProfile().nethack, false);
    const nonePayload = encoded & ~((1 << 25) | (0b11 << 26));

    expect(decodeRuntimeSettings(nonePayload).settings).toMatchObject({
      permInvent: false,
      perminvMode: "all",
    });
  });

  it.each([
    ["protocol 1", (1 << 28) | (1 << 6)],
    ["protocol 3", (3 << 28) | (1 << 6)],
    ["reserved bit 31", 0x80000000 | (2 << 28) | (1 << 6)],
    ["invalid number_pad code", (2 << 28) | (6 << 7) | (1 << 6)],
    ["ambiguous pickup mode", (2 << 28) | (1 << 6) | (1 << 10)],
    ["empty pickup selection", 2 << 28],
  ])("rejects %s", (_name, payload) => {
    expect(() => decodeRuntimeSettings(payload)).toThrow();
  });
});
