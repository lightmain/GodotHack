import { describe, expect, it } from "vitest";
import {
  createDefaultProfile,
  createProfileExport,
  MESSAGE_HISTORY_LINES,
  NUMBER_PAD_MODES,
  parseProfileImport,
  parseStoredProfile,
  PICKUP_CLASS_SYMBOLS,
  PROFILE_IMPORT_MAX_BYTES,
  ProfileFormatError,
  serializeProfileExport,
  TERMINAL_FONT_SIZES,
  validateProfile,
} from "./profile";

const encoder = new TextEncoder();

function expectProfileError(
  action: () => unknown,
  code: ProfileFormatError["code"],
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileFormatError);
    expect((error as ProfileFormatError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ProfileFormatError with code ${code}`);
}

describe("profile defaults and validation", () => {
  it("returns the reviewed defaults as independent objects", () => {
    const first = createDefaultProfile();
    const second = createDefaultProfile();

    expect(first).toEqual({
      schemaVersion: 1,
      interface: {
        terminalFontSize: "medium",
        messageHistoryLines: 5,
        followPlayer: true,
        permanentInventoryPosition: "right",
        permanentInventoryCollapsed: false,
      },
      nethack: {
        tutorial: true,
        autopickup: true,
        pickupTypes: { mode: "all" },
        numberPad: 0,
        safePet: true,
        sortpack: true,
        showExperience: false,
        showTime: false,
        permInvent: false,
        perminvMode: "all",
      },
    });
    first.interface.terminalFontSize = "large";
    expect(second.interface.terminalFontSize).toBe("medium");
  });

  it.each(TERMINAL_FONT_SIZES)(
    "accepts terminal font size %s",
    (terminalFontSize) => {
      const profile = createDefaultProfile();
      profile.interface.terminalFontSize = terminalFontSize;

      expect(validateProfile(profile).interface.terminalFontSize)
        .toBe(terminalFontSize);
    },
  );

  it.each(MESSAGE_HISTORY_LINES)(
    "accepts message history height %s",
    (messageHistoryLines) => {
      const profile = createDefaultProfile();
      profile.interface.messageHistoryLines = messageHistoryLines;

      expect(validateProfile(profile).interface.messageHistoryLines)
        .toBe(messageHistoryLines);
    },
  );

  it.each(NUMBER_PAD_MODES)(
    "accepts number_pad mode %s",
    (numberPad) => {
      const profile = createDefaultProfile();
      profile.nethack.numberPad = numberPad;

      expect(validateProfile(profile).nethack.numberPad).toBe(numberPad);
    },
  );

  it.each([
    ["right", true],
    ["below", false],
  ] as const)(
    "accepts permanent inventory position %s with collapsed=%s",
    (permanentInventoryPosition, permanentInventoryCollapsed) => {
      const profile = createDefaultProfile();
      profile.interface.permanentInventoryPosition = permanentInventoryPosition;
      profile.interface.permanentInventoryCollapsed = permanentInventoryCollapsed;

      expect(validateProfile(profile).interface).toMatchObject({
        permanentInventoryPosition,
        permanentInventoryCollapsed,
      });
    },
  );

  it.each(["all", "full", "in-use"] as const)(
    "accepts permanent inventory mode %s",
    (perminvMode) => {
      const profile = createDefaultProfile();
      profile.nethack.permInvent = true;
      profile.nethack.perminvMode = perminvMode;

      expect(validateProfile(profile).nethack).toMatchObject({
        permInvent: true,
        perminvMode,
      });
    },
  );

  it("canonicalizes selected pickup classes into inventory order", () => {
    const profile = createDefaultProfile();
    profile.nethack.pickupTypes = {
      mode: "selected",
      classes: ["_", "$", ")", "\""],
    };

    expect(validateProfile(profile).nethack.pickupTypes).toEqual({
      mode: "selected",
      classes: ["$", "\"", ")", "_"],
    });
  });

  it.each([
    ["missing field", (profile: Record<string, unknown>) => {
      delete (profile.interface as Record<string, unknown>).followPlayer;
    }],
    ["unknown field", (profile: Record<string, unknown>) => {
      (profile.nethack as Record<string, unknown>).unknown = true;
    }],
    ["wrong boolean type", (profile: Record<string, unknown>) => {
      (profile.nethack as Record<string, unknown>).safePet = "yes";
    }],
    ["invalid font enum", (profile: Record<string, unknown>) => {
      (profile.interface as Record<string, unknown>).terminalFontSize = "huge";
    }],
    ["invalid number_pad mode", (profile: Record<string, unknown>) => {
      (profile.nethack as Record<string, unknown>).numberPad = 5;
    }],
    ["invalid inventory position", (profile: Record<string, unknown>) => {
      (profile.interface as Record<string, unknown>).permanentInventoryPosition = "left";
    }],
    ["obsolete inventory width", (profile: Record<string, unknown>) => {
      (profile.interface as Record<string, unknown>).permanentInventoryWidth = "wide";
    }],
    ["invalid collapsed type", (profile: Record<string, unknown>) => {
      (profile.interface as Record<string, unknown>).permanentInventoryCollapsed = "no";
    }],
    ["invalid permanent inventory toggle", (profile: Record<string, unknown>) => {
      (profile.nethack as Record<string, unknown>).permInvent = 1;
    }],
    ["invalid permanent inventory mode", (profile: Record<string, unknown>) => {
      (profile.nethack as Record<string, unknown>).perminvMode = "gold";
    }],
    ["empty selected pickup classes", (profile: Record<string, unknown>) => {
      (profile.nethack as Record<string, unknown>).pickupTypes = {
        mode: "selected",
        classes: [],
      };
    }],
    ["duplicate pickup class", (profile: Record<string, unknown>) => {
      (profile.nethack as Record<string, unknown>).pickupTypes = {
        mode: "selected",
        classes: ["$", "$"],
      };
    }],
    ["unknown pickup class", (profile: Record<string, unknown>) => {
      (profile.nethack as Record<string, unknown>).pickupTypes = {
        mode: "selected",
        classes: [":"],
      };
    }],
  ])("rejects a profile with %s", (_name, mutate) => {
    const profile = createDefaultProfile() as unknown as Record<string, unknown>;
    mutate(profile);

    expect(() => validateProfile(profile)).toThrow(ProfileFormatError);
  });

  it("rejects malformed JSON and unsupported schema versions distinctly", () => {
    expectProfileError(() => parseStoredProfile("{bad"), "invalid-json");
    expectProfileError(() => parseStoredProfile(JSON.stringify({
      ...createDefaultProfile(),
      schemaVersion: 2,
    })), "unsupported-schema");
  });

  it("strictly rejects the pre-permanent-inventory schema 1 shape", () => {
    const oldProfile = createDefaultProfile() as unknown as {
      interface: Record<string, unknown>;
      nethack: Record<string, unknown>;
    };
    delete oldProfile.interface.permanentInventoryPosition;
    delete oldProfile.interface.permanentInventoryCollapsed;
    delete oldProfile.nethack.permInvent;
    delete oldProfile.nethack.perminvMode;

    expect(() => validateProfile(oldProfile)).toThrow(ProfileFormatError);
  });

  it("validates every supported pickup class", () => {
    const profile = createDefaultProfile();
    profile.nethack.pickupTypes = {
      mode: "selected",
      classes: [...PICKUP_CLASS_SYMBOLS],
    };

    expect(validateProfile(profile).nethack.pickupTypes).toEqual(
      profile.nethack.pickupTypes,
    );
  });
});

describe("profile import and export", () => {
  it("serializes deterministic metadata and round-trips strict UTF-8", () => {
    const profile = createDefaultProfile();
    const exportedAt = new Date("2026-09-06T12:34:56.789Z");
    const json = serializeProfileExport(profile, "prealpha-3", exportedAt);

    expect(json.endsWith("\n")).toBe(true);
    expect(json).not.toContain("\r");
    expect(parseProfileImport(encoder.encode(json))).toEqual({
      schemaVersion: 1,
      productVersion: "prealpha-3",
      exportedAt: "2026-09-06T12:34:56.789Z",
      interface: profile.interface,
      nethack: profile.nethack,
    });
  });

  it("rejects unknown export fields and non-canonical timestamps", () => {
    const document = createProfileExport(
      createDefaultProfile(),
      "prealpha-3",
      new Date("2026-09-06T12:34:56.789Z"),
    ) as unknown as Record<string, unknown>;
    document.extra = true;
    expectProfileError(() => parseProfileImport(
      encoder.encode(JSON.stringify(document)),
    ), "invalid-profile");

    delete document.extra;
    document.exportedAt = "2026-09-06";
    expectProfileError(() => parseProfileImport(
      encoder.encode(JSON.stringify(document)),
    ), "invalid-profile");
  });

  it("rejects a schema 1 profile export using the old field set", () => {
    const document = createProfileExport(
      createDefaultProfile(),
      "prealpha-3",
      new Date("2026-09-06T12:34:56.789Z"),
    ) as unknown as {
      interface: Record<string, unknown>;
      nethack: Record<string, unknown>;
    };
    delete document.interface.permanentInventoryPosition;
    delete document.interface.permanentInventoryCollapsed;
    delete document.nethack.permInvent;
    delete document.nethack.perminvMode;

    expectProfileError(
      () => parseProfileImport(encoder.encode(JSON.stringify(document))),
      "invalid-profile",
    );
  });

  it("rejects oversized, BOM-prefixed, NUL, and invalid UTF-8 documents", () => {
    expectProfileError(() => parseProfileImport(
      new Uint8Array(PROFILE_IMPORT_MAX_BYTES + 1),
    ), "file-too-large");
    expectProfileError(() => parseProfileImport(
      encoder.encode("\uFEFF{}"),
    ), "invalid-encoding");
    expectProfileError(() => parseProfileImport(
      encoder.encode("{\0}"),
    ), "invalid-encoding");
    expectProfileError(() => parseProfileImport(
      Uint8Array.of(0xff),
    ), "invalid-encoding");
  });
});
