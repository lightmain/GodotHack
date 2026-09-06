import {
  BackupFormatError,
  parseBackupImport,
  serializeBackup,
  type ParsedBackupV1,
} from "./backup-file";
import {
  type SaveIdentity,
  type SaveListEntry,
  type SaveValidation,
  type StorageService,
} from "../storage/storage-service";
import type { BlissHackProfileV1 } from "../settings/profile";

export type BackupImportClassification =
  | "importable"
  | "incompatible"
  | "damaged"
  | "conflict";

export interface BackupImportPreviewEntry {
  fileName: string;
  bytes: Uint8Array;
  classification: BackupImportClassification;
  identity: SaveIdentity | null;
  existing: SaveListEntry | null;
}

export interface BackupImportPreview {
  source: Pick<
    ParsedBackupV1,
    "productVersion" | "buildId" | "exportedAt" | "profile"
  >;
  entries: BackupImportPreviewEntry[];
}

export type BackupSaveImportReason =
  | "created"
  | "overwritten"
  | "incompatible"
  | "conflict-not-overwritten"
  | "damaged"
  | "write-failed";

export interface BackupSaveImportResult {
  fileName: string;
  status: "imported" | "skipped" | "failed";
  reason: BackupSaveImportReason;
}

export interface BackupImportSummary {
  results: BackupSaveImportResult[];
  imported: number;
  skipped: number;
  failed: number;
}

/** Fatal batch failure after a save transaction could not roll back. */
export class BackupRollbackError extends Error {
  readonly results: BackupSaveImportResult[];

  constructor(results: BackupSaveImportResult[], cause: unknown) {
    super("Backup import could not restore local save data", { cause });
    this.name = "BackupRollbackError";
    this.results = results;
  }
}

/** Current local saves changed after the player reviewed an import preview. */
export class BackupPreviewStaleError extends Error {
  readonly preview: BackupImportPreview;

  constructor(preview: BackupImportPreview) {
    super("Local saves changed after the backup preview was created");
    this.name = "BackupPreviewStaleError";
    this.preview = preview;
  }
}

/**
 * Serialize the current profile and all formal save bytes.
 * @param storage - module-bound storage service.
 * @param profile - current applied profile.
 * @param productVersion - player-visible product version.
 * @param buildId - deployment build identifier.
 */
export async function exportFullBackup(
  storage: StorageService,
  profile: BlissHackProfileV1,
  productVersion: string,
  buildId: string,
): Promise<string> {
  const saves = await storage.exportAllSaves();
  return serializeBackup(profile, saves, productVersion, buildId);
}

/**
 * Fully validate and classify an untrusted backup without writing storage.
 * @param storage - current module used for save compatibility checks.
 * @param bytes - selected backup file bytes.
 */
export async function previewFullBackup(
  storage: StorageService,
  bytes: Uint8Array,
): Promise<BackupImportPreview> {
  const parsed = await parseBackupImport(bytes);
  const existingSaves = await storage.listSaves();
  const identities = new Set<string>();
  const entries: BackupImportPreviewEntry[] = [];

  for (const save of parsed.saves) {
    let validation = await storage.validateSave(save.bytes);
    if (
      validation.status === "ready"
      && identities.has(validation.identity.playerName)
    ) {
      throw new BackupFormatError(
        "invalid-backup",
        "Backup contains a duplicate player identity",
      );
    }
    if (
      validation.status === "ready"
      && save.fileName !== `0${validation.identity.playerName}`
    ) {
      validation = {
        status: "damaged",
        reason: "identity-file-name-mismatch",
      };
    }
    if (validation.status === "ready") {
      identities.add(validation.identity.playerName);
    }
    entries.push(classifyEntry(save.fileName, save.bytes, validation, existingSaves));
  }

  return {
    source: {
      productVersion: parsed.productVersion,
      buildId: parsed.buildId,
      exportedAt: parsed.exportedAt,
      profile: parsed.profile,
    },
    entries,
  };
}

/**
 * Reclassify a validated preview against the latest module and save list.
 * @param storage - refreshed module-bound storage.
 * @param preview - previously validated immutable backup bytes.
 * @returns a new preview retaining source metadata and bytes.
 */
export async function refreshBackupPreview(
  storage: StorageService,
  preview: BackupImportPreview,
): Promise<BackupImportPreview> {
  const existingSaves = await storage.listSaves();
  const entries: BackupImportPreviewEntry[] = [];
  for (const entry of preview.entries) {
    let validation = await storage.validateSave(entry.bytes);
    if (
      validation.status === "ready"
      && entry.fileName !== `0${validation.identity.playerName}`
    ) {
      validation = {
        status: "damaged",
        reason: "identity-file-name-mismatch",
      };
    }
    entries.push(classifyEntry(
      entry.fileName,
      entry.bytes,
      validation,
      existingSaves,
    ));
  }
  return { source: preview.source, entries };
}

/**
 * Return whether two previews authorize the same current storage targets.
 * @param reviewed - preview explicitly confirmed by the player.
 * @param current - preview rebuilt after obtaining the import lock.
 */
export function backupPreviewMatches(
  reviewed: BackupImportPreview,
  current: BackupImportPreview,
): boolean {
  if (reviewed.entries.length !== current.entries.length) return false;
  return reviewed.entries.every((entry, index) => {
    const other = current.entries[index];
    return other !== undefined
      && entry.fileName === other.fileName
      && entry.classification === other.classification
      && saveRevision(entry.existing) === saveRevision(other.existing);
  });
}

/**
 * Import each approved compatible save while preserving per-file results.
 * @param storage - current module-bound storage.
 * @param preview - fully validated retained preview.
 * @param overwriteFileNames - conflicts explicitly approved by the player.
 */
export async function importFullBackup(
  storage: StorageService,
  preview: BackupImportPreview,
  overwriteFileNames: ReadonlySet<string>,
): Promise<BackupImportSummary> {
  const results: BackupSaveImportResult[] = [];
  for (const entry of preview.entries) {
    if (entry.classification === "incompatible") {
      results.push(result(entry.fileName, "skipped", "incompatible"));
      continue;
    }
    if (entry.classification === "damaged" || !entry.identity) {
      results.push(result(entry.fileName, "failed", "damaged"));
      continue;
    }
    const overwrite = entry.classification === "conflict"
      && overwriteFileNames.has(entry.fileName);
    if (entry.classification === "conflict" && !overwrite) {
      results.push(result(
        entry.fileName,
        "skipped",
        "conflict-not-overwritten",
      ));
      continue;
    }

    try {
      const imported = await storage.importSave({
        bytes: entry.bytes,
        modifiedAt: null,
        overwrite,
      });
      if (imported.status === "conflict") {
        results.push(result(
          entry.fileName,
          "skipped",
          "conflict-not-overwritten",
        ));
      } else {
        results.push(result(
          entry.fileName,
          "imported",
          overwrite ? "overwritten" : "created",
        ));
      }
    } catch (error) {
      results.push(result(entry.fileName, "failed", "write-failed"));
      if (error instanceof AggregateError) {
        throw new BackupRollbackError(results, error);
      }
    }
  }
  return summarize(results);
}

/** Convert current validation and path occupancy into one preview row. */
function classifyEntry(
  fileName: string,
  bytes: Uint8Array,
  validation: SaveValidation,
  existingSaves: SaveListEntry[],
): BackupImportPreviewEntry {
  const existing = existingSaves.find(
    (save) => save.path === `/save/${fileName}`,
  ) ?? null;
  if (validation.status === "incompatible") {
    return {
      fileName,
      bytes,
      classification: "incompatible",
      identity: null,
      existing,
    };
  }
  if (validation.status === "damaged") {
    return {
      fileName,
      bytes,
      classification: "damaged",
      identity: null,
      existing,
    };
  }
  return {
    fileName,
    bytes,
    classification: existing ? "conflict" : "importable",
    identity: validation.identity,
    existing,
  };
}

/** Build one immutable per-save result row. */
function result(
  fileName: string,
  status: BackupSaveImportResult["status"],
  reason: BackupSaveImportReason,
): BackupSaveImportResult {
  return { fileName, status, reason };
}

/** Count each result category without discarding individual outcomes. */
function summarize(results: BackupSaveImportResult[]): BackupImportSummary {
  return {
    results,
    imported: results.filter((entry) => entry.status === "imported").length,
    skipped: results.filter((entry) => entry.status === "skipped").length,
    failed: results.filter((entry) => entry.status === "failed").length,
  };
}

/** Build a non-content revision for one currently occupied formal path. */
function saveRevision(save: SaveListEntry | null): string {
  if (!save) return "missing";
  const identity = save.status === "ready"
    ? `${save.identity.playerName}:${save.identity.role}:${
      save.identity.race
    }:${save.identity.gender}:${save.identity.alignment}`
    : `${save.status}:${save.reason}`;
  return `${save.path}:${save.modifiedAt ?? "unknown"}:${identity}`;
}
