import { describe, expect, it } from "vitest";
import {
  createDefaultProfile,
  NUMBER_PAD_MODES,
  PICKUP_CLASS_SYMBOLS,
} from "./profile";
import { generateNetHackRc } from "./nethackrc";

describe("NetHack rc generation", () => {
  it("generates the reviewed defaults in fixed order with LF endings", () => {
    const rc = generateNetHackRc(createDefaultProfile().nethack);

    expect(rc).toBe([
      "OPTIONS=autopickup",
      "OPTIONS=pickup_types:all",
      "OPTIONS=number_pad:0",
      "OPTIONS=safe_pet",
      "OPTIONS=sortpack",
      "OPTIONS=!showexp",
      "OPTIONS=!time",
      "OPTIONS=tutorial",
      "",
    ].join("\n"));
    expect(rc).not.toContain("\r");
  });

  it.each(NUMBER_PAD_MODES)(
    "writes number_pad mode %s exactly",
    (numberPad) => {
      const settings = createDefaultProfile().nethack;
      settings.numberPad = numberPad;

      expect(generateNetHackRc(settings))
        .toContain(`OPTIONS=number_pad:${numberPad}\n`);
    },
  );

  it("negates every disabled boolean option explicitly", () => {
    const settings = createDefaultProfile().nethack;
    settings.tutorial = false;
    settings.autopickup = false;
    settings.safePet = false;
    settings.sortpack = false;
    settings.showExperience = false;
    settings.showTime = false;

    expect(generateNetHackRc(settings).split("\n")).toEqual([
      "OPTIONS=!autopickup",
      "OPTIONS=pickup_types:all",
      "OPTIONS=number_pad:0",
      "OPTIONS=!safe_pet",
      "OPTIONS=!sortpack",
      "OPTIONS=!showexp",
      "OPTIONS=!time",
      "OPTIONS=!tutorial",
      "",
    ]);
  });

  it("enables status fields without negation", () => {
    const settings = createDefaultProfile().nethack;
    settings.showExperience = true;
    settings.showTime = true;
    const rc = generateNetHackRc(settings);

    expect(rc).toContain("OPTIONS=showexp\n");
    expect(rc).toContain("OPTIONS=time\n");
  });

  it("emits selected pickup symbols in canonical inventory order", () => {
    const settings = createDefaultProfile().nethack;
    settings.pickupTypes = {
      mode: "selected",
      classes: ["_", ")", "\"", "$"],
    };

    expect(generateNetHackRc(settings))
      .toContain("OPTIONS=pickup_types:$\")_\n");
  });

  it("can emit every supported pickup class without arbitrary text", () => {
    const settings = createDefaultProfile().nethack;
    settings.pickupTypes = {
      mode: "selected",
      classes: [...PICKUP_CLASS_SYMBOLS],
    };
    const rc = generateNetHackRc(settings);

    expect(rc).toContain(
      `OPTIONS=pickup_types:${PICKUP_CLASS_SYMBOLS.join("")}\n`,
    );
    expect(rc.split("\n").filter(Boolean)).toHaveLength(8);
    for (const line of rc.split("\n").filter(Boolean)) {
      expect(line).toMatch(/^OPTIONS=[!a-z_].*$/);
    }
  });

  it("rejects invalid runtime values instead of generating partial rc", () => {
    const settings = createDefaultProfile().nethack as unknown as Record<
      string,
      unknown
    >;
    settings.numberPad = 99;

    expect(() => generateNetHackRc(settings as never))
      .toThrow(/numberPad/);
  });
});
