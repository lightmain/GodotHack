import type { EmscriptenModule } from "../nethack-bridge";
import { generateNetHackRc } from "./nethackrc";
import type { NetHackSettingsV1 } from "./profile";

export const NETHACKRC_PATH = "/home/web_user/.nethackrc";
const TEMPORARY_NETHACKRC_PATH = "/home/web_user/.nethackrc.blisshack.tmp";

interface RuntimeConfigFileSystem {
  analyzePath(path: string): { exists: boolean };
  readFile(path: string): string | Uint8Array;
  rename(oldPath: string, newPath: string): unknown;
  unlink(path: string): unknown;
  writeFile(path: string, bytes: Uint8Array): unknown;
}

/**
 * Atomically install the generated rc into one prepared in-memory module.
 * @param module - module which will own the next NetHack main invocation.
 * @param settings - validated structured NetHack settings.
 */
export function installRuntimeNetHackRc(
  module: EmscriptenModule,
  settings: NetHackSettingsV1,
): void {
  const fileSystem = requireRuntimeFileSystem(module.FS);
  const generated = new TextEncoder().encode(generateNetHackRc(settings));
  const original = fileSystem.analyzePath(NETHACKRC_PATH).exists
    ? readBytes(fileSystem, NETHACKRC_PATH)
    : null;
  let destinationChanged = false;

  try {
    removeIfPresent(fileSystem, TEMPORARY_NETHACKRC_PATH);
    fileSystem.writeFile(TEMPORARY_NETHACKRC_PATH, generated);
    assertEqualFile(fileSystem, TEMPORARY_NETHACKRC_PATH, generated);
    fileSystem.rename(TEMPORARY_NETHACKRC_PATH, NETHACKRC_PATH);
    destinationChanged = true;
    assertEqualFile(fileSystem, NETHACKRC_PATH, generated);
  } catch (installError) {
    try {
      if (destinationChanged) {
        if (original) {
          fileSystem.writeFile(TEMPORARY_NETHACKRC_PATH, original);
          assertEqualFile(fileSystem, TEMPORARY_NETHACKRC_PATH, original);
          fileSystem.rename(TEMPORARY_NETHACKRC_PATH, NETHACKRC_PATH);
        } else {
          removeIfPresent(fileSystem, NETHACKRC_PATH);
        }
      }
      removeIfPresent(fileSystem, TEMPORARY_NETHACKRC_PATH);
    } catch (rollbackError) {
      throw new AggregateError(
        [installError, rollbackError],
        "Could not install or restore the runtime NetHack configuration",
      );
    }
    throw installError;
  }
}

function requireRuntimeFileSystem(value: unknown): RuntimeConfigFileSystem {
  if (
    typeof value !== "object"
    || value === null
    || !hasFunction(value, "analyzePath")
    || !hasFunction(value, "readFile")
    || !hasFunction(value, "rename")
    || !hasFunction(value, "unlink")
    || !hasFunction(value, "writeFile")
  ) {
    throw new Error("Runtime filesystem does not support configuration install");
  }
  return value as RuntimeConfigFileSystem;
}

function hasFunction(value: object, name: string): boolean {
  return name in value
    && typeof (value as Record<string, unknown>)[name] === "function";
}

function readBytes(
  fileSystem: RuntimeConfigFileSystem,
  path: string,
): Uint8Array {
  const value = fileSystem.readFile(path);
  if (typeof value === "string") {
    throw new Error(`Expected binary runtime configuration at ${path}`);
  }
  return value.slice();
}

function assertEqualFile(
  fileSystem: RuntimeConfigFileSystem,
  path: string,
  expected: Uint8Array,
): void {
  const actual = readBytes(fileSystem, path);
  if (
    actual.length !== expected.length
    || !actual.every((byte, index) => byte === expected[index])
  ) {
    throw new Error("Runtime NetHack configuration verification failed");
  }
}

function removeIfPresent(
  fileSystem: RuntimeConfigFileSystem,
  path: string,
): void {
  if (fileSystem.analyzePath(path).exists) fileSystem.unlink(path);
}
