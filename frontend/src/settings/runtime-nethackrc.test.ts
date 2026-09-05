import { describe, expect, it, vi } from "vitest";
import type { EmscriptenModule } from "../nethack-bridge";
import { createDefaultProfile } from "./profile";
import {
  installRuntimeNetHackRc,
  NETHACKRC_PATH,
} from "./runtime-nethackrc";

const TEMPORARY_PATH = "/home/web_user/.nethackrc.blisshack.tmp";

function createFileSystem(initial?: string) {
  const files = new Map<string, Uint8Array>();
  if (initial !== undefined) {
    files.set(NETHACKRC_PATH, new TextEncoder().encode(initial));
  }
  const fileSystem = {
    analyzePath: vi.fn((path: string) => ({ exists: files.has(path) })),
    readFile: vi.fn((path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return bytes.slice();
    }),
    writeFile: vi.fn((path: string, bytes: Uint8Array) => {
      files.set(path, bytes.slice());
    }),
    rename: vi.fn((oldPath: string, newPath: string) => {
      const bytes = files.get(oldPath);
      if (!bytes) throw new Error(`ENOENT: ${oldPath}`);
      files.set(newPath, bytes);
      files.delete(oldPath);
    }),
    unlink: vi.fn((path: string) => {
      if (!files.delete(path)) throw new Error(`ENOENT: ${path}`);
    }),
  };
  return { fileSystem, files };
}

function asModule(fileSystem: object): EmscriptenModule {
  return { FS: fileSystem } as unknown as EmscriptenModule;
}

describe("runtime NetHack rc installation", () => {
  it("writes, verifies, and atomically renames the generated profile", () => {
    const { fileSystem, files } = createFileSystem();
    const settings = createDefaultProfile().nethack;
    settings.tutorial = false;
    settings.numberPad = 3;
    settings.showTime = true;

    installRuntimeNetHackRc(asModule(fileSystem), settings);

    expect(new TextDecoder().decode(files.get(NETHACKRC_PATH))).toBe([
      "OPTIONS=autopickup",
      "OPTIONS=pickup_types:all",
      "OPTIONS=number_pad:3",
      "OPTIONS=safe_pet",
      "OPTIONS=sortpack",
      "OPTIONS=!showexp",
      "OPTIONS=time",
      "OPTIONS=!tutorial",
      "",
    ].join("\n"));
    expect(files.has(TEMPORARY_PATH)).toBe(false);
    expect(fileSystem.rename).toHaveBeenCalledWith(
      TEMPORARY_PATH,
      NETHACKRC_PATH,
    );
  });

  it("replaces an old rc with the latest complete settings", () => {
    const { fileSystem, files } = createFileSystem("old");
    const settings = createDefaultProfile().nethack;
    settings.autopickup = false;

    installRuntimeNetHackRc(asModule(fileSystem), settings);

    const installed = new TextDecoder().decode(files.get(NETHACKRC_PATH));
    expect(installed).toContain("OPTIONS=!autopickup\n");
    expect(installed).not.toContain("old");
  });

  it("leaves the old rc untouched when the temporary write cannot be verified", () => {
    const { fileSystem, files } = createFileSystem("old");
    fileSystem.writeFile.mockImplementation((path: string) => {
      files.set(path, Uint8Array.of(0xff));
    });

    expect(() => installRuntimeNetHackRc(
      asModule(fileSystem),
      createDefaultProfile().nethack,
    )).toThrow(/verification/);

    expect(new TextDecoder().decode(files.get(NETHACKRC_PATH))).toBe("old");
    expect(files.has(TEMPORARY_PATH)).toBe(false);
    expect(fileSystem.rename).not.toHaveBeenCalled();
  });

  it("restores the old rc when verification fails after replacement", () => {
    const { fileSystem, files } = createFileSystem("old");
    let corruptDestination = true;
    fileSystem.readFile.mockImplementation((path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      if (
        path === NETHACKRC_PATH
        && fileSystem.rename.mock.calls.length === 1
        && corruptDestination
      ) {
        corruptDestination = false;
        return Uint8Array.of(0xff);
      }
      return bytes.slice();
    });

    expect(() => installRuntimeNetHackRc(
      asModule(fileSystem),
      createDefaultProfile().nethack,
    )).toThrow(/verification/);

    expect(new TextDecoder().decode(files.get(NETHACKRC_PATH))).toBe("old");
    expect(files.has(TEMPORARY_PATH)).toBe(false);
    expect(fileSystem.rename).toHaveBeenCalledTimes(2);
  });

  it("removes a newly installed destination when post-rename verification fails", () => {
    const { fileSystem, files } = createFileSystem();
    fileSystem.readFile.mockImplementation((path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return path === NETHACKRC_PATH ? Uint8Array.of(0xff) : bytes.slice();
    });

    expect(() => installRuntimeNetHackRc(
      asModule(fileSystem),
      createDefaultProfile().nethack,
    )).toThrow(/verification/);

    expect(files.has(NETHACKRC_PATH)).toBe(false);
    expect(files.has(TEMPORARY_PATH)).toBe(false);
  });

  it("rejects an incomplete filesystem before changing any file", () => {
    const { fileSystem, files } = createFileSystem("old");
    const incomplete = { ...fileSystem, rename: undefined };

    expect(() => installRuntimeNetHackRc(
      asModule(incomplete),
      createDefaultProfile().nethack,
    )).toThrow(/does not support/);
    expect(new TextDecoder().decode(files.get(NETHACKRC_PATH))).toBe("old");
  });
});
