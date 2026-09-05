import {
  PICKUP_CLASS_SYMBOLS,
  validateNetHackSettings,
  type NetHackSettingsV1,
} from "./profile";

/**
 * Generate the complete runtime rc fragment owned by BlissHack settings.
 * Field names and ordering are fixed; no arbitrary text reaches NetHack.
 */
export function generateNetHackRc(settings: NetHackSettingsV1): string {
  const normalized = validateNetHackSettings(settings);
  const pickupTypes = normalized.pickupTypes.mode === "all"
    ? "all"
    : PICKUP_CLASS_SYMBOLS
      .filter((symbol) => normalized.pickupTypes.mode === "selected"
        && normalized.pickupTypes.classes.includes(symbol))
      .join("");

  return [
    booleanOption("autopickup", normalized.autopickup),
    `OPTIONS=pickup_types:${pickupTypes}`,
    `OPTIONS=number_pad:${normalized.numberPad}`,
    booleanOption("safe_pet", normalized.safePet),
    booleanOption("sortpack", normalized.sortpack),
    booleanOption("showexp", normalized.showExperience),
    booleanOption("time", normalized.showTime),
    booleanOption("tutorial", normalized.tutorial),
  ].join("\n").concat("\n");
}

function booleanOption(name: string, enabled: boolean): string {
  return `OPTIONS=${enabled ? "" : "!"}${name}`;
}
