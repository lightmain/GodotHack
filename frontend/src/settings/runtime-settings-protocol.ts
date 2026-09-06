import {
  NUMBER_PAD_MODES,
  PICKUP_CLASS_SYMBOLS,
  validateNetHackSettings,
  type NetHackSettingsV1,
} from "./profile";

export type RuntimeNetHackSettings = Omit<NetHackSettingsV1, "tutorial">;

const PROTOCOL_VERSION = 1;
const PENDING_BIT = 1 << 0;
const AUTOPICKUP_BIT = 1 << 1;
const SAFE_PET_BIT = 1 << 2;
const SORTPACK_BIT = 1 << 3;
const SHOW_EXPERIENCE_BIT = 1 << 4;
const SHOW_TIME_BIT = 1 << 5;
const PICKUP_ALL_BIT = 1 << 6;
const NUMBER_PAD_SHIFT = 7;
const NUMBER_PAD_MASK = 0b111 << NUMBER_PAD_SHIFT;
const PICKUP_SHIFT = 10;
const PICKUP_MASK = 0x7fff << PICKUP_SHIFT;
const VERSION_SHIFT = 28;
const VERSION_MASK = 0b111 << VERSION_SHIFT;
const DEFINED_MASK = (
  PENDING_BIT
  | AUTOPICKUP_BIT
  | SAFE_PET_BIT
  | SORTPACK_BIT
  | SHOW_EXPERIENCE_BIT
  | SHOW_TIME_BIT
  | PICKUP_ALL_BIT
  | NUMBER_PAD_MASK
  | PICKUP_MASK
  | VERSION_MASK
) >>> 0;

/** Encode a validated dynamic settings snapshot for the WASM32 shim. */
export function encodeRuntimeSettings(
  settings: NetHackSettingsV1 | RuntimeNetHackSettings,
  pending: boolean,
): number {
  const normalized = "tutorial" in settings
    ? runtimeSettingsFromProfile(settings)
    : validateRuntimeSettings(settings);
  const numberPadCode = NUMBER_PAD_MODES.indexOf(normalized.numberPad);
  let payload = (PROTOCOL_VERSION << VERSION_SHIFT)
    | (pending ? PENDING_BIT : 0)
    | (normalized.autopickup ? AUTOPICKUP_BIT : 0)
    | (normalized.safePet ? SAFE_PET_BIT : 0)
    | (normalized.sortpack ? SORTPACK_BIT : 0)
    | (normalized.showExperience ? SHOW_EXPERIENCE_BIT : 0)
    | (normalized.showTime ? SHOW_TIME_BIT : 0)
    | (normalized.pickupTypes.mode === "all" ? PICKUP_ALL_BIT : 0)
    | (numberPadCode << NUMBER_PAD_SHIFT);

  if (normalized.pickupTypes.mode === "selected") {
    normalized.pickupTypes.classes.forEach((symbol) => {
      payload |= 1 << (
        PICKUP_SHIFT + PICKUP_CLASS_SYMBOLS.indexOf(symbol)
      );
    });
  }
  return payload >>> 0;
}

/** Decode and reject any unknown, malformed, or version-mismatched payload. */
export function decodeRuntimeSettings(payload: number): {
  pending: boolean;
  settings: RuntimeNetHackSettings;
} {
  if (!Number.isInteger(payload)) {
    throw new Error("Runtime settings payload must be an integer");
  }
  const unsigned = payload >>> 0;
  if ((unsigned & ~DEFINED_MASK) !== 0) {
    throw new Error("Runtime settings payload contains reserved bits");
  }
  if (((unsigned & VERSION_MASK) >>> VERSION_SHIFT) !== PROTOCOL_VERSION) {
    throw new Error("Runtime settings protocol version is unsupported");
  }

  const numberPadCode = (unsigned & NUMBER_PAD_MASK) >>> NUMBER_PAD_SHIFT;
  const numberPad = NUMBER_PAD_MODES[numberPadCode];
  if (numberPad === undefined) {
    throw new Error("Runtime settings number_pad code is invalid");
  }

  const pickupAll = (unsigned & PICKUP_ALL_BIT) !== 0;
  const pickupBits = (unsigned & PICKUP_MASK) >>> PICKUP_SHIFT;
  if (pickupAll && pickupBits !== 0) {
    throw new Error("Runtime settings pickup mode is ambiguous");
  }
  const classes = PICKUP_CLASS_SYMBOLS.filter(
    (_symbol, index) => (pickupBits & (1 << index)) !== 0,
  );
  if (!pickupAll && classes.length === 0) {
    throw new Error("Runtime settings pickup selection is empty");
  }

  return {
    pending: (unsigned & PENDING_BIT) !== 0,
    settings: {
      autopickup: (unsigned & AUTOPICKUP_BIT) !== 0,
      pickupTypes: pickupAll
        ? { mode: "all" }
        : { mode: "selected", classes },
      numberPad,
      safePet: (unsigned & SAFE_PET_BIT) !== 0,
      sortpack: (unsigned & SORTPACK_BIT) !== 0,
      showExperience: (unsigned & SHOW_EXPERIENCE_BIT) !== 0,
      showTime: (unsigned & SHOW_TIME_BIT) !== 0,
    },
  };
}

/** Drop the startup-only tutorial field from one complete profile section. */
export function runtimeSettingsFromProfile(
  settings: NetHackSettingsV1,
): RuntimeNetHackSettings {
  const normalized = validateNetHackSettings(settings);
  return {
    autopickup: normalized.autopickup,
    pickupTypes: normalized.pickupTypes,
    numberPad: normalized.numberPad,
    safePet: normalized.safePet,
    sortpack: normalized.sortpack,
    showExperience: normalized.showExperience,
    showTime: normalized.showTime,
  };
}

/** Validate a dynamic-only settings object through the complete V1 schema. */
function validateRuntimeSettings(
  settings: RuntimeNetHackSettings,
): RuntimeNetHackSettings {
  return runtimeSettingsFromProfile({
    tutorial: true,
    ...settings,
  });
}
