import {
  validateProfile,
  type BlissHackProfileV1,
} from "../settings/profile";

/** Current full-backup container schema. */
export const BACKUP_SCHEMA_VERSION = 1;
/** Largest accepted UTF-8 JSON backup. */
export const BACKUP_IMPORT_MAX_BYTES = 96 * 1024 * 1024;
/** Largest number of formal saves in one backup. */
export const BACKUP_MAX_SAVE_COUNT = 100;
/** Largest decoded save and aggregate decoded save payload. */
export const BACKUP_MAX_SAVE_BYTES = 64 * 1024 * 1024;

export interface BackupSaveV1 {
  fileName: string;
  byteLength: number;
  sha256: string;
  data: string;
}

export interface BlissHackBackupV1 {
  format: "blisshack-backup";
  schemaVersion: 1;
  productVersion: string;
  buildId: string;
  exportedAt: string;
  profile: BlissHackProfileV1;
  saves: BackupSaveV1[];
}

export interface BackupSaveBytes {
  fileName: string;
  bytes: Uint8Array;
}

export interface ParsedBackupV1 {
  productVersion: string;
  buildId: string;
  exportedAt: string;
  profile: BlissHackProfileV1;
  saves: BackupSaveBytes[];
}

export type BackupFormatErrorCode =
  | "file-too-large"
  | "invalid-encoding"
  | "invalid-json"
  | "invalid-backup"
  | "unsupported-schema";

/** Stable format failure used by UI and tests without exposing file content. */
export class BackupFormatError extends Error {
  readonly code: BackupFormatErrorCode;

  constructor(code: BackupFormatErrorCode, message: string) {
    super(message);
    this.name = "BackupFormatError";
    this.code = code;
  }
}

/**
 * Build and serialize one complete backup.
 * @param profile - current applied profile.
 * @param saves - every formal save and its exact bytes.
 * @param productVersion - player-visible product version.
 * @param buildId - diagnostic build identifier.
 * @param exportedAt - deterministic timestamp override for tests.
 * @returns UTF-8 JSON text with stable save ordering.
 */
export async function serializeBackup(
  profile: BlissHackProfileV1,
  saves: BackupSaveBytes[],
  productVersion: string,
  buildId: string,
  exportedAt: Date = new Date(),
): Promise<string> {
  assertMetadataToken(productVersion, 64, "productVersion");
  assertMetadataToken(buildId, 128, "buildId");
  if (Number.isNaN(exportedAt.getTime())) {
    throw invalidBackup("exportedAt must be a valid date");
  }
  if (saves.length > BACKUP_MAX_SAVE_COUNT) {
    throw invalidBackup("Backup contains too many saves");
  }

  let totalBytes = 0;
  const names = new Set<string>();
  const encodedSaves: BackupSaveV1[] = [];
  for (const save of [...saves].sort(compareSaveNames)) {
    assertFormalSaveFileName(save.fileName);
    if (names.has(save.fileName)) {
      throw invalidBackup("Backup contains a duplicate save file name");
    }
    names.add(save.fileName);
    assertSaveLength(save.bytes.byteLength);
    totalBytes += save.bytes.byteLength;
    if (totalBytes > BACKUP_MAX_SAVE_BYTES) {
      throw invalidBackup("Backup save data exceeds the 64 MiB aggregate limit");
    }
    encodedSaves.push({
      fileName: save.fileName,
      byteLength: save.bytes.byteLength,
      sha256: await sha256Hex(save.bytes),
      data: encodeBase64(save.bytes),
    });
  }

  const document: BlissHackBackupV1 = {
    format: "blisshack-backup",
    schemaVersion: BACKUP_SCHEMA_VERSION,
    productVersion,
    buildId,
    exportedAt: exportedAt.toISOString(),
    profile: validateProfile(profile),
    saves: encodedSaves,
  };
  const json = `${JSON.stringify(document, null, 2)}\n`;
  if (new TextEncoder().encode(json).byteLength > BACKUP_IMPORT_MAX_BYTES) {
    throw invalidBackup("Backup JSON exceeds the 96 MiB limit");
  }
  return json;
}

/**
 * Parse and verify one untrusted full-backup document.
 * @param bytes - complete selected file bytes.
 * @returns normalized metadata, profile, and detached raw save bytes.
 */
export async function parseBackupImport(
  bytes: Uint8Array,
): Promise<ParsedBackupV1> {
  if (bytes.byteLength > BACKUP_IMPORT_MAX_BYTES) {
    throw new BackupFormatError(
      "file-too-large",
      "Backup exceeds the 96 MiB import limit",
    );
  }
  if (
    bytes.byteLength >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf
  ) {
    throw new BackupFormatError("invalid-encoding", "Backup contains a UTF-8 BOM");
  }

  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BackupFormatError("invalid-encoding", "Backup is not valid UTF-8");
  }
  if (json.startsWith("\uFEFF") || json.includes("\0")) {
    throw new BackupFormatError(
      "invalid-encoding",
      "Backup contains a BOM or NUL byte",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new BackupFormatError("invalid-json", "Backup is not valid JSON");
  }
  const document = requireRecord(parsed, "backup");
  if (document.format !== "blisshack-backup") {
    throw invalidBackup("Backup format is invalid");
  }
  if (document.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new BackupFormatError(
      "unsupported-schema",
      "Backup schema version is not supported",
    );
  }
  assertMetadataToken(document.productVersion, 64, "productVersion");
  assertMetadataToken(document.buildId, 128, "buildId");
  assertIsoTimestamp(document.exportedAt);

  let profile: BlissHackProfileV1;
  try {
    profile = validateProfile(document.profile);
  } catch {
    throw invalidBackup("Backup profile is invalid");
  }
  if (
    !Array.isArray(document.saves)
    || document.saves.length > BACKUP_MAX_SAVE_COUNT
  ) {
    throw invalidBackup("Backup save list is invalid");
  }

  let totalBytes = 0;
  const names = new Set<string>();
  const saves: BackupSaveBytes[] = [];
  for (const [index, value] of document.saves.entries()) {
    const save = requireRecord(value, `saves[${index}]`);
    assertFormalSaveFileName(save.fileName);
    if (names.has(save.fileName)) {
      throw invalidBackup("Backup contains a duplicate save file name");
    }
    names.add(save.fileName);
    if (
      !Number.isSafeInteger(save.byteLength)
      || (save.byteLength as number) < 0
      || (save.byteLength as number) > BACKUP_MAX_SAVE_BYTES
    ) {
      throw invalidBackup(`saves[${index}].byteLength is invalid`);
    }
    totalBytes += save.byteLength as number;
    if (totalBytes > BACKUP_MAX_SAVE_BYTES) {
      throw invalidBackup("Backup save data exceeds the 64 MiB aggregate limit");
    }
    if (
      typeof save.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(save.sha256)
    ) {
      throw invalidBackup(`saves[${index}].sha256 is invalid`);
    }
    if (typeof save.data !== "string") {
      throw invalidBackup(`saves[${index}].data is invalid`);
    }
    const expectedEncodedLength = 4 * Math.ceil((save.byteLength as number) / 3);
    if (save.data.length !== expectedEncodedLength) {
      throw invalidBackup(`saves[${index}] encoded length does not match`);
    }
    const decoded = decodeCanonicalBase64(save.data);
    if (decoded.byteLength !== save.byteLength) {
      throw invalidBackup(`saves[${index}] byte length does not match`);
    }
    if (await sha256Hex(decoded) !== save.sha256) {
      throw invalidBackup(`saves[${index}] checksum does not match`);
    }
    saves.push({ fileName: save.fileName, bytes: decoded });
  }

  return {
    productVersion: document.productVersion,
    buildId: document.buildId,
    exportedAt: document.exportedAt,
    profile,
    saves,
  };
}

/**
 * Validate a direct NetHack WASM save basename.
 * @param value - untrusted basename.
 */
export function assertFormalSaveFileName(
  value: unknown,
): asserts value is string {
  if (
    typeof value !== "string"
    || !value.startsWith("0")
    || /[./\\\s]/.test(value)
    || [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw invalidBackup("Save file name is invalid");
  }
  const nameBytes = new TextEncoder().encode(value.slice(1)).byteLength;
  if (nameBytes < 1 || nameBytes > 31) {
    throw invalidBackup("Save file name is invalid");
  }
}

/**
 * Calculate a lowercase SHA-256 digest.
 * @param bytes - bytes to hash without modification.
 * @returns 64 lowercase hexadecimal characters.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto SHA-256 is unavailable");
  }
  const input = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input.buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Encode bytes with canonical RFC 4648 Base64.
 * @param bytes - binary payload.
 * @returns padded standard-alphabet Base64.
 */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }
  return btoa(binary);
}

/**
 * Decode Base64 and reject alternate or non-canonical representations.
 * @param value - untrusted Base64 text.
 * @returns detached decoded bytes.
 */
function decodeCanonicalBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
      .test(value)
  ) {
    throw invalidBackup("Save data is not canonical Base64");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw invalidBackup("Save data is not valid Base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (encodeBase64(bytes) !== value) {
    throw invalidBackup("Save data is not canonical Base64");
  }
  return bytes;
}

/** Compare backup saves by exact basename for deterministic output. */
function compareSaveNames(left: BackupSaveBytes, right: BackupSaveBytes): number {
  const leftPoints = Array.from(
    left.fileName,
    (value) => value.codePointAt(0) as number,
  );
  const rightPoints = Array.from(
    right.fileName,
    (value) => value.codePointAt(0) as number,
  );
  const count = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < count; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index];
    }
  }
  return leftPoints.length - rightPoints.length;
}

/** Reject a decoded save length outside the schema limit. */
function assertSaveLength(byteLength: number): void {
  if (byteLength < 0 || byteLength > BACKUP_MAX_SAVE_BYTES) {
    throw invalidBackup("Save byte length is outside the supported range");
  }
}

/** Validate one bounded printable-ASCII metadata field. */
function assertMetadataToken(
  value: unknown,
  maxLength: number,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw invalidBackup(`${field} is invalid`);
  }
}

/** Require a canonical millisecond-precision UTC timestamp. */
function assertIsoTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw invalidBackup("exportedAt must be a canonical UTC timestamp");
  }
}

/** Require an object-like JSON value and return its keyed view. */
function requireRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidBackup(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Construct a stable invalid-container error. */
function invalidBackup(message: string): BackupFormatError {
  return new BackupFormatError("invalid-backup", message);
}
