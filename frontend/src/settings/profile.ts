/** Current browser and export schema version for BlissHack settings. */
export const PROFILE_SCHEMA_VERSION = 1;
/** Maximum accepted size of an imported profile document. */
export const PROFILE_IMPORT_MAX_BYTES = 1024 * 1024;

export const TERMINAL_FONT_SIZES = ["small", "medium", "large"] as const;
export type TerminalFontSize = (typeof TERMINAL_FONT_SIZES)[number];

export const MESSAGE_HISTORY_LINES = [3, 5] as const;
export type MessageHistoryLines = (typeof MESSAGE_HISTORY_LINES)[number];

export const PERMANENT_INVENTORY_POSITIONS = ["right", "below"] as const;
export type PermanentInventoryPosition =
  (typeof PERMANENT_INVENTORY_POSITIONS)[number];

export const NUMBER_PAD_MODES = [0, 1, 2, 3, 4, -1] as const;
export type NumberPadMode = (typeof NUMBER_PAD_MODES)[number];

export const PERMINV_MODES = ["all", "full", "in-use"] as const;
export type PerminvMode = (typeof PERMINV_MODES)[number];

/**
 * Pickable object class symbols in NetHack's default inventory order.
 * Illegal objects and wizard-only venom are intentionally omitted.
 */
export const PICKUP_CLASS_SYMBOLS = [
  "$",
  "\"",
  ")",
  "[",
  "%",
  "?",
  "+",
  "!",
  "=",
  "/",
  "(",
  "*",
  "`",
  "0",
  "_",
] as const;
export type PickupClassSymbol = (typeof PICKUP_CLASS_SYMBOLS)[number];

export interface InterfaceSettingsV1 {
  terminalFontSize: TerminalFontSize;
  messageHistoryLines: MessageHistoryLines;
  followPlayer: boolean;
  permanentInventoryPosition: PermanentInventoryPosition;
  permanentInventoryCollapsed: boolean;
}

export type PickupTypesV1 =
  | { mode: "all" }
  | { mode: "selected"; classes: PickupClassSymbol[] };

export interface NetHackSettingsV1 {
  tutorial: boolean;
  autopickup: boolean;
  pickupTypes: PickupTypesV1;
  numberPad: NumberPadMode;
  safePet: boolean;
  sortpack: boolean;
  showExperience: boolean;
  showTime: boolean;
  permInvent: boolean;
  perminvMode: PerminvMode;
}

export interface BlissHackProfileV1 {
  schemaVersion: 1;
  interface: InterfaceSettingsV1;
  nethack: NetHackSettingsV1;
}

export interface BlissHackProfileExportV1 extends BlissHackProfileV1 {
  productVersion: string;
  exportedAt: string;
}

export type ProfileFormatErrorCode =
  | "invalid-json"
  | "invalid-profile"
  | "unsupported-schema"
  | "invalid-encoding"
  | "file-too-large";

/** Validation failure with a stable code suitable for user-facing mapping. */
export class ProfileFormatError extends Error {
  readonly code: ProfileFormatErrorCode;

  constructor(code: ProfileFormatErrorCode, message: string) {
    super(message);
    this.name = "ProfileFormatError";
    this.code = code;
  }
}

/** Return a fresh profile so callers cannot mutate shared defaults. */
export function createDefaultProfile(): BlissHackProfileV1 {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
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
  };
}

/**
 * Validate and normalize an unknown profile into a detached V1 value.
 * Unknown and missing properties are rejected at every object level.
 */
export function validateProfile(value: unknown): BlissHackProfileV1 {
  const profile = requireRecord(value, "profile");
  assertExactKeys(profile, ["schemaVersion", "interface", "nethack"], "profile");
  assertSchemaVersion(profile.schemaVersion);

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    interface: validateInterfaceSettings(profile.interface),
    nethack: validateNetHackSettings(profile.nethack),
  };
}

/** Parse one persisted JSON string using the strict profile schema. */
export function parseStoredProfile(json: string): BlissHackProfileV1 {
  return validateProfile(parseJson(json));
}

/** Create a detached, strictly validated export document. */
export function createProfileExport(
  profile: BlissHackProfileV1,
  productVersion: string,
  exportedAt: Date = new Date(),
): BlissHackProfileExportV1 {
  const normalized = validateProfile(profile);
  assertProductVersion(productVersion);
  if (Number.isNaN(exportedAt.getTime())) {
    throw invalidProfile("exportedAt must be a valid date");
  }
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    productVersion,
    exportedAt: exportedAt.toISOString(),
    interface: normalized.interface,
    nethack: normalized.nethack,
  };
}

/** Serialize an export with deterministic indentation and LF termination. */
export function serializeProfileExport(
  profile: BlissHackProfileV1,
  productVersion: string,
  exportedAt: Date = new Date(),
): string {
  return `${JSON.stringify(
    createProfileExport(profile, productVersion, exportedAt),
    null,
    2,
  )}\n`;
}

/** Decode and validate an imported UTF-8 profile document. */
export function parseProfileImport(
  bytes: Uint8Array,
): BlissHackProfileExportV1 {
  if (bytes.byteLength > PROFILE_IMPORT_MAX_BYTES) {
    throw new ProfileFormatError(
      "file-too-large",
      "Profile exceeds the 1 MiB import limit",
    );
  }
  if (
    bytes.byteLength >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf
  ) {
    throw new ProfileFormatError(
      "invalid-encoding",
      "Profile contains a UTF-8 BOM",
    );
  }

  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProfileFormatError(
      "invalid-encoding",
      "Profile is not valid UTF-8",
    );
  }
  if (json.startsWith("\uFEFF") || json.includes("\0")) {
    throw new ProfileFormatError(
      "invalid-encoding",
      "Profile contains a BOM or NUL byte",
    );
  }

  const document = requireRecord(parseJson(json), "profile export");
  assertExactKeys(
    document,
    [
      "schemaVersion",
      "productVersion",
      "exportedAt",
      "interface",
      "nethack",
    ],
    "profile export",
  );
  assertSchemaVersion(document.schemaVersion);
  assertProductVersion(document.productVersion);
  assertIsoTimestamp(document.exportedAt);

  const profile = validateProfile({
    schemaVersion: document.schemaVersion,
    interface: document.interface,
    nethack: document.nethack,
  });
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    productVersion: document.productVersion,
    exportedAt: document.exportedAt,
    interface: profile.interface,
    nethack: profile.nethack,
  };
}

/** Validate and normalize the interface section independently. */
export function validateInterfaceSettings(
  value: unknown,
): InterfaceSettingsV1 {
  const settings = requireRecord(value, "interface");
  assertExactKeys(
    settings,
    [
      "terminalFontSize",
      "messageHistoryLines",
      "followPlayer",
      "permanentInventoryPosition",
      "permanentInventoryCollapsed",
    ],
    "interface",
  );
  if (!isOneOf(settings.terminalFontSize, TERMINAL_FONT_SIZES)) {
    throw invalidProfile("interface.terminalFontSize is invalid");
  }
  if (!isOneOf(settings.messageHistoryLines, MESSAGE_HISTORY_LINES)) {
    throw invalidProfile("interface.messageHistoryLines is invalid");
  }
  assertBoolean(settings.followPlayer, "interface.followPlayer");
  if (!isOneOf(
    settings.permanentInventoryPosition,
    PERMANENT_INVENTORY_POSITIONS,
  )) {
    throw invalidProfile("interface.permanentInventoryPosition is invalid");
  }
  assertBoolean(
    settings.permanentInventoryCollapsed,
    "interface.permanentInventoryCollapsed",
  );

  return {
    terminalFontSize: settings.terminalFontSize,
    messageHistoryLines: settings.messageHistoryLines,
    followPlayer: settings.followPlayer,
    permanentInventoryPosition: settings.permanentInventoryPosition,
    permanentInventoryCollapsed: settings.permanentInventoryCollapsed,
  };
}

/** Validate and normalize the NetHack section independently. */
export function validateNetHackSettings(
  value: unknown,
): NetHackSettingsV1 {
  const settings = requireRecord(value, "nethack");
  assertExactKeys(
    settings,
    [
      "tutorial",
      "autopickup",
      "pickupTypes",
      "numberPad",
      "safePet",
      "sortpack",
      "showExperience",
      "showTime",
      "permInvent",
      "perminvMode",
    ],
    "nethack",
  );
  assertBoolean(settings.tutorial, "nethack.tutorial");
  assertBoolean(settings.autopickup, "nethack.autopickup");
  if (!isOneOf(settings.numberPad, NUMBER_PAD_MODES)) {
    throw invalidProfile("nethack.numberPad is invalid");
  }
  assertBoolean(settings.safePet, "nethack.safePet");
  assertBoolean(settings.sortpack, "nethack.sortpack");
  assertBoolean(settings.showExperience, "nethack.showExperience");
  assertBoolean(settings.showTime, "nethack.showTime");
  assertBoolean(settings.permInvent, "nethack.permInvent");
  if (!isOneOf(settings.perminvMode, PERMINV_MODES)) {
    throw invalidProfile("nethack.perminvMode is invalid");
  }

  return {
    tutorial: settings.tutorial,
    autopickup: settings.autopickup,
    pickupTypes: validatePickupTypes(settings.pickupTypes),
    numberPad: settings.numberPad,
    safePet: settings.safePet,
    sortpack: settings.sortpack,
    showExperience: settings.showExperience,
    showTime: settings.showTime,
    permInvent: settings.permInvent,
    perminvMode: settings.perminvMode,
  };
}

function validatePickupTypes(value: unknown): PickupTypesV1 {
  const pickupTypes = requireRecord(value, "nethack.pickupTypes");
  if (pickupTypes.mode === "all") {
    assertExactKeys(pickupTypes, ["mode"], "nethack.pickupTypes");
    return { mode: "all" };
  }
  if (pickupTypes.mode !== "selected") {
    throw invalidProfile("nethack.pickupTypes.mode is invalid");
  }
  assertExactKeys(
    pickupTypes,
    ["mode", "classes"],
    "nethack.pickupTypes",
  );
  if (!Array.isArray(pickupTypes.classes) || pickupTypes.classes.length === 0) {
    throw invalidProfile(
      "nethack.pickupTypes.classes must contain at least one class",
    );
  }

  const selected = new Set<PickupClassSymbol>();
  for (const value of pickupTypes.classes) {
    if (!isOneOf(value, PICKUP_CLASS_SYMBOLS)) {
      throw invalidProfile("nethack.pickupTypes.classes contains an invalid class");
    }
    if (selected.has(value)) {
      throw invalidProfile("nethack.pickupTypes.classes contains a duplicate");
    }
    selected.add(value);
  }
  return {
    mode: "selected",
    classes: PICKUP_CLASS_SYMBOLS.filter((symbol) => selected.has(symbol)),
  };
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new ProfileFormatError("invalid-json", "Profile is not valid JSON");
  }
}

function assertSchemaVersion(value: unknown): asserts value is 1 {
  if (value !== PROFILE_SCHEMA_VERSION) {
    throw new ProfileFormatError(
      "unsupported-schema",
      "Profile schema version is not supported",
    );
  }
}

function assertProductVersion(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidProfile("productVersion must be a non-empty string");
  }
}

function assertIsoTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw invalidProfile("exportedAt must be a canonical UTC timestamp");
  }
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw invalidProfile(`${path} must be boolean`);
  }
}

function requireRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidProfile(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length
    || actual.some((key, index) => key !== required[index])
  ) {
    throw invalidProfile(`${path} contains missing or unknown fields`);
  }
}

function isOneOf<const T extends readonly unknown[]>(
  value: unknown,
  choices: T,
): value is T[number] {
  return choices.includes(value);
}

function invalidProfile(message: string): ProfileFormatError {
  return new ProfileFormatError("invalid-profile", message);
}
