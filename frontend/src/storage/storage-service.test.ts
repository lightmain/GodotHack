import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStorageModuleHarness,
  type StorageModuleHarness,
} from "./storage-test-helpers";

/** Result returned by the narrow shim C validator for one candidate file. */
type SaveValidation =
  | { status: "ready"; identity: { playerName: string } }
  | { status: "damaged"; reason: "truncated" };

/** Save-list record produced from a candidate path and its validation. */
type SaveListEntry = { path: string; modifiedAt: number | null } & SaveValidation;

/** Metadata validator backed in production by the narrow shim C interface. */
type MetadataValidator = (
  module: StorageModuleHarness["module"],
  path: string,
) => Promise<SaveValidation>;

/** Stage-two storage service behavior exercised without a browser IDBFS. */
interface StorageServiceContract {
  initialize(): Promise<boolean>;
  refreshFromPersistent(): Promise<SaveListEntry[]>;
  listSaves(): Promise<SaveListEntry[]>;
  readSave(path: string): Promise<Uint8Array>;
  restoreOriginalSave(path: string, bytes: Uint8Array): Promise<void>;
  deleteSave(path: string): Promise<void>;
  exportAllSaves(): Promise<Array<{ fileName: string; bytes: Uint8Array }>>;
  clearManagedFiles(): Promise<Array<{ path: string; bytes: Uint8Array }>>;
  restoreManagedFiles(
    files: Array<{ path: string; bytes: Uint8Array }>,
  ): Promise<void>;
  flush(): Promise<void>;
}

/** Module exports required by the stage-two storage tests. */
interface StorageServiceModule {
  createStorageService(
    module: StorageModuleHarness["module"],
    options: { validateSaveMetadata: MetadataValidator },
  ): StorageServiceContract;
}

/**
 * Load the future production service at test execution time.
 * @returns the storage service module under test.
 */
async function loadStorageService(): Promise<StorageServiceModule> {
  const implementationUrl = new URL("./storage-service.ts", import.meta.url).href;
  return import(/* @vite-ignore */ implementationUrl) as Promise<StorageServiceModule>;
}

/**
 * Create a service with browser persistence enabled for one fake module.
 * @param harness - in-memory module fixture.
 * @param validateSaveMetadata - injected narrow shim metadata validator.
 * @returns stage-two storage service.
 */
async function createService(
  harness: StorageModuleHarness,
  validateSaveMetadata: MetadataValidator = async (_module, path) => ({
    status: "ready",
    identity: { playerName: path.slice("/save/0".length) },
  }),
): Promise<StorageServiceContract> {
  vi.stubGlobal("indexedDB", {});
  const { createStorageService } = await loadStorageService();
  expect(createStorageService).toBeTypeOf("function");
  return createStorageService(harness.module, { validateSaveMetadata });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("storage service initialization", () => {
  it("mounts and populates /save exactly once across concurrent initialize calls", async () => {
    const harness = createStorageModuleHarness();
    const service = await createService(harness);

    const first = service.initialize();
    const duplicate = service.initialize();

    expect(harness.module.FS.mkdir).toHaveBeenCalledTimes(1);
    expect(harness.module.FS.mount).toHaveBeenCalledTimes(1);
    expect(harness.module.FS.mount).toHaveBeenCalledWith(
      harness.module.IDBFS,
      { autoPersist: false },
      "/save",
    );
    expect(harness.syncRequests.map(({ populate }) => populate)).toEqual([true]);

    harness.syncRequests[0].complete();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([true, true]);

    await expect(service.initialize()).resolves.toBe(true);
    expect(harness.module.FS.mount).toHaveBeenCalledTimes(1);
    expect(harness.syncRequests).toHaveLength(1);
  });

  it.each([
    { missing: "IDBFS", idbfsAvailable: false, indexedDbAvailable: true },
    { missing: "IndexedDB", idbfsAvailable: true, indexedDbAvailable: false },
  ])("returns unavailable without mounting when $missing is absent", async ({
    idbfsAvailable,
    indexedDbAvailable,
  }) => {
    const harness = createStorageModuleHarness({ idbfsAvailable });
    if (indexedDbAvailable) vi.stubGlobal("indexedDB", {});
    else vi.stubGlobal("indexedDB", undefined);
    const { createStorageService } = await loadStorageService();
    const service = createStorageService(harness.module, {
      validateSaveMetadata: vi.fn(),
    });

    await expect(service.initialize()).resolves.toBe(false);
    expect(harness.module.FS.mount).not.toHaveBeenCalled();
    expect(harness.module.FS.syncfs).not.toHaveBeenCalled();
  });

  it("returns unavailable deterministically when mount or populate fails", async () => {
    const mountFailure = createStorageModuleHarness({
      mountError: new Error("IDBFS mount failed"),
    });
    const mountService = await createService(mountFailure);

    await expect(mountService.initialize()).resolves.toBe(false);

    const populateFailure = createStorageModuleHarness();
    const populateService = await createService(populateFailure);
    const initialization = populateService.initialize();
    populateFailure.syncRequests[0].complete(new Error("populate failed"));

    await expect(initialization).resolves.toBe(false);
  });
});

describe("storage service synchronization queue", () => {
  it("repopulates IDBFS before returning a refreshed save list", async () => {
    const harness = createStorageModuleHarness();
    const validateSaveMetadata = vi.fn<MetadataValidator>(
      async () => ({
        status: "ready",
        identity: { playerName: "Ada" },
      }),
    );
    const service = await createService(harness, validateSaveMetadata);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;
    harness.files.set("/save/0Ada", Uint8Array.of(1));

    const refresh = service.refreshFromPersistent();
    await vi.waitFor(() => {
      expect(harness.syncRequests).toHaveLength(2);
    });
    expect(harness.syncRequests.map(({ populate }) => populate)).toEqual([
      true,
      true,
    ]);
    harness.syncRequests[1].complete();

    await expect(refresh).resolves.toEqual([
      expect.objectContaining({ path: "/save/0Ada", status: "ready" }),
    ]);
    expect(validateSaveMetadata).toHaveBeenCalledOnce();
  });

  it("serializes populate and concurrent flush calls through one queue", async () => {
    const harness = createStorageModuleHarness();
    const service = await createService(harness);
    const initialization = service.initialize();

    expect(harness.syncRequests.map(({ populate }) => populate)).toEqual([true]);
    harness.syncRequests[0].complete();
    await expect(initialization).resolves.toBe(true);

    const first = service.flush();
    const second = service.flush();
    const third = service.flush();
    await Promise.resolve();

    expect(harness.syncRequests.map(({ populate }) => populate)).toEqual([
      true,
      false,
    ]);

    harness.syncRequests[1].complete();
    await first;
    await Promise.resolve();
    expect(harness.syncRequests.map(({ populate }) => populate)).toEqual([
      true,
      false,
      false,
    ]);

    harness.syncRequests[2].complete();
    await second;
    await Promise.resolve();
    expect(harness.syncRequests.map(({ populate }) => populate)).toEqual([
      true,
      false,
      false,
      false,
    ]);

    harness.syncRequests[3].complete();
    await expect(third).resolves.toBeUndefined();
  });

  it("rejects the failed flush without allowing a later flush to overtake it", async () => {
    const harness = createStorageModuleHarness();
    const service = await createService(harness);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    const failed = service.flush();
    const later = service.flush();
    await Promise.resolve();
    harness.syncRequests[1].complete(new Error("quota exceeded"));

    await expect(failed).rejects.toThrow("quota exceeded");
    await Promise.resolve();
    expect(harness.syncRequests).toHaveLength(3);
    harness.syncRequests[2].complete();
    await expect(later).resolves.toBeUndefined();
  });
});

describe("save file access", () => {
  it("lists only direct regular save candidates and excludes temporary content", async () => {
    const harness = createStorageModuleHarness();
    const validatedSave: SaveListEntry = {
      path: "/save/0Ada",
      modifiedAt: 0,
      status: "ready",
      identity: { playerName: "Ada" },
    };
    const validateSaveMetadata = vi.fn<MetadataValidator>(
      async () => ({
        status: "ready",
        identity: validatedSave.identity,
      }),
    );
    harness.files.set("/save/0Ada", Uint8Array.of(1));
    harness.files.set("/save/0Ada.tmp", Uint8Array.of(2));
    harness.files.set("/save/0Ada.bak", Uint8Array.of(3));
    harness.files.set("/save/0Ada~", Uint8Array.of(4));
    harness.files.set("/save/level.0", Uint8Array.of(5));
    harness.files.set("/save/notes.txt", Uint8Array.of(6));
    harness.files.set("/save/nested/0Other", Uint8Array.of(7));
    const service = await createService(harness, validateSaveMetadata);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    await expect(service.listSaves()).resolves.toEqual([validatedSave]);
    expect(validateSaveMetadata).toHaveBeenCalledOnce();
    expect(validateSaveMetadata).toHaveBeenCalledWith(
      harness.module,
      "/save/0Ada",
    );
  });

  it("keeps a damaged save candidate as a disabled list entry", async () => {
    const harness = createStorageModuleHarness();
    harness.files.set("/save/0Broken", Uint8Array.of(0x00));
    const service = await createService(harness, async () => ({
      status: "damaged",
      reason: "truncated",
    }));
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    await expect(service.listSaves()).resolves.toEqual([{
      path: "/save/0Broken",
      modifiedAt: 0,
      status: "damaged",
      reason: "truncated",
    }]);
  });

  it("returns the original binary bytes without text decoding or mutation", async () => {
    const harness = createStorageModuleHarness();
    const original = Uint8Array.of(0x00, 0xff, 0x80, 0x41, 0x00);
    harness.files.set("/save/0BinaryHero", original);
    const service = await createService(harness);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    const bytes = await service.readSave("/save/0BinaryHero");

    expect(bytes).toEqual(original);
    expect(bytes).not.toBe(original);
    expect(harness.module.FS.readFile).toHaveBeenCalledWith("/save/0BinaryHero");
  });

  it("exports every formal save even when validation cannot continue it", async () => {
    const harness = createStorageModuleHarness();
    harness.files.set("/save/0Ada", Uint8Array.of(1));
    harness.files.set("/save/0Broken", Uint8Array.of(2));
    harness.files.set("/save/notes.txt", Uint8Array.of(3));
    const service = await createService(harness, async (_module, path) =>
      path.endsWith("Ada")
        ? { status: "ready", identity: { playerName: "Ada" } }
        : { status: "damaged", reason: "truncated" });
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    await expect(service.exportAllSaves()).resolves.toEqual([
      { fileName: "0Ada", bytes: Uint8Array.of(1) },
      { fileName: "0Broken", bytes: Uint8Array.of(2) },
    ]);
  });

  it("fails a complete export when a formal file cannot be stated", async () => {
    const harness = createStorageModuleHarness();
    harness.files.set("/save/0Ada", Uint8Array.of(1));
    harness.module.FS.stat.mockImplementation((path: string) => {
      if (path === "/save/0Ada") throw new Error("stat failed");
      return { mode: 0x4000 };
    });
    const service = await createService(harness);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    await expect(service.exportAllSaves()).rejects.toThrow("stat failed");
  });

  it("propagates validator failures instead of damaging every listed save", async () => {
    const harness = createStorageModuleHarness();
    harness.files.set("/save/0Ada", Uint8Array.of(1));
    const service = await createService(harness, async () => {
      throw new Error("fingerprint unavailable");
    });
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    await expect(service.listSaves()).rejects.toThrow("fingerprint unavailable");
  });

  it("rejects a missing save read instead of returning guessed content", async () => {
    const harness = createStorageModuleHarness();
    const service = await createService(harness);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    await expect(service.readSave("/save/0Missing")).rejects.toThrow("ENOENT");
  });

  it("restores the preserved bytes after a failed Continue without a general write API", async () => {
    const harness = createStorageModuleHarness();
    const original = Uint8Array.of(0x10, 0x00, 0xff, 0x20);
    harness.files.set("/save/0Ada", Uint8Array.of(0x99));
    const service = await createService(harness);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    await service.restoreOriginalSave("/save/0Ada", original);

    expect(harness.module.FS.writeFile).toHaveBeenCalledWith(
      "/save/0Ada",
      original,
    );
    expect(harness.files.get("/save/0Ada")).toEqual(original);
    expect("writeSave" in service).toBe(false);
  });
});

describe("managed storage clearing", () => {
  it("refuses an oversized rollback snapshot before deleting files", async () => {
    const harness = createStorageModuleHarness();
    harness.files.set("/save/0Ada", Uint8Array.of(1));
    harness.module.FS.stat.mockImplementation((path: string) => {
      if (path === "/save/0Ada") {
        return { mode: 0x8000, size: 64 * 1024 * 1024 + 1 };
      }
      return { mode: 0x4000 };
    });
    const service = await createService(harness);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    await expect(service.clearManagedFiles()).rejects.toThrow(
      "safe clear limit",
    );
    expect(harness.files.get("/save/0Ada")).toEqual(Uint8Array.of(1));
    expect(harness.module.FS.unlink).not.toHaveBeenCalled();
  });

  it("clears all regular mount files and can restore the returned snapshot", async () => {
    const harness = createStorageModuleHarness();
    harness.files.set("/save/0Ada", Uint8Array.of(1));
    harness.files.set("/save/level.0", Uint8Array.of(2));
    const service = await createService(harness);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    const clearing = service.clearManagedFiles();
    await vi.waitFor(() => expect(harness.syncRequests).toHaveLength(2));
    harness.syncRequests[1].complete();
    const snapshot = await clearing;
    expect(harness.files.size).toBe(0);
    expect(snapshot).toEqual([
      { path: "/save/0Ada", bytes: Uint8Array.of(1) },
      { path: "/save/level.0", bytes: Uint8Array.of(2) },
    ]);

    const restoring = service.restoreManagedFiles(snapshot);
    await vi.waitFor(() => expect(harness.syncRequests).toHaveLength(3));
    harness.syncRequests[2].complete();
    await restoring;
    expect(harness.files.get("/save/0Ada")).toEqual(Uint8Array.of(1));
    expect(harness.files.get("/save/level.0")).toEqual(Uint8Array.of(2));
  });

  it("restores all bytes when the clear flush fails", async () => {
    const harness = createStorageModuleHarness();
    harness.files.set("/save/0Ada", Uint8Array.of(1, 2, 3));
    const service = await createService(harness);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    const clearing = service.clearManagedFiles();
    await vi.waitFor(() => expect(harness.syncRequests).toHaveLength(2));
    harness.syncRequests[1].complete(new Error("clear failed"));
    await vi.waitFor(() => expect(harness.syncRequests).toHaveLength(3));
    harness.syncRequests[2].complete();

    await expect(clearing).rejects.toThrow("clear failed");
    expect(harness.files.get("/save/0Ada")).toEqual(Uint8Array.of(1, 2, 3));
  });
});

describe("save deletion", () => {
  it("backs up bytes before unlinking and persists the deletion", async () => {
    const harness = createStorageModuleHarness();
    const original = Uint8Array.of(0x10, 0x00, 0xff, 0x20);
    harness.files.set("/save/0Ada", original);
    const service = await createService(harness);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    const deletion = service.deleteSave("/save/0Ada");
    await vi.waitFor(() => {
      expect(harness.syncRequests).toHaveLength(2);
    });

    expect(harness.module.FS.readFile).toHaveBeenCalledWith("/save/0Ada");
    expect(harness.module.FS.unlink).toHaveBeenCalledWith("/save/0Ada");
    expect(harness.files.has("/save/0Ada")).toBe(false);
    expect(harness.syncRequests[1].populate).toBe(false);
    expect(harness.module.FS.readFile.mock.invocationCallOrder[0])
      .toBeLessThan(harness.module.FS.unlink.mock.invocationCallOrder[0]);
    expect(harness.module.FS.unlink.mock.invocationCallOrder[0])
      .toBeLessThan(harness.module.FS.syncfs.mock.invocationCallOrder[1]);

    harness.syncRequests[1].complete();
    await expect(deletion).resolves.toBeUndefined();
    expect(harness.files.has("/save/0Ada")).toBe(false);
  });

  it.each([
    "/save",
    "/save/",
    "/save/../0Ada",
    "/save/nested/0Ada",
    "/save/0Ada.bak",
    "/tmp/0Ada",
  ])("rejects invalid deletion path %s without touching the file system", async (
    path,
  ) => {
    const harness = createStorageModuleHarness();
    harness.files.set("/save/0Ada", Uint8Array.of(1, 2, 3));
    const service = await createService(harness);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    await expect(service.deleteSave(path)).rejects.toThrow("Invalid save path");

    expect(harness.module.FS.readFile).not.toHaveBeenCalled();
    expect(harness.module.FS.unlink).not.toHaveBeenCalled();
    expect(harness.module.FS.writeFile).not.toHaveBeenCalled();
    expect(harness.syncRequests).toHaveLength(1);
    expect(harness.files.get("/save/0Ada")).toEqual(Uint8Array.of(1, 2, 3));
  });

  it("restores original bytes and syncs again when persisting deletion fails", async () => {
    const harness = createStorageModuleHarness();
    const original = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
    harness.files.set("/save/0Ada", original);
    const service = await createService(harness);
    const initialization = service.initialize();
    harness.syncRequests[0].complete();
    await initialization;

    const deletion = service.deleteSave("/save/0Ada");
    const rejection = expect(deletion).rejects.toThrow("quota exceeded");
    await vi.waitFor(() => {
      expect(harness.syncRequests).toHaveLength(2);
    });
    expect(harness.files.has("/save/0Ada")).toBe(false);

    harness.syncRequests[1].complete(new Error("quota exceeded"));
    await vi.waitFor(() => {
      expect(harness.module.FS.writeFile).toHaveBeenCalledWith(
        "/save/0Ada",
        original,
      );
      expect(harness.syncRequests).toHaveLength(3);
    });

    expect(harness.files.get("/save/0Ada")).toEqual(original);
    expect(harness.syncRequests[2].populate).toBe(false);
    expect(harness.module.FS.writeFile.mock.invocationCallOrder[0])
      .toBeLessThan(harness.module.FS.syncfs.mock.invocationCallOrder[2]);

    harness.syncRequests[2].complete();
    await rejection;
    expect(harness.files.get("/save/0Ada")).toEqual(original);
  });
});
