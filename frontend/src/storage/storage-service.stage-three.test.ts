import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStorageModuleHarness,
  type StorageModuleHarness,
} from "./storage-test-helpers";

interface SaveIdentity {
  playerName: string;
  role: string;
  race: string;
  gender: string;
  alignment: string;
}

type SaveValidation =
  | { status: "ready"; identity: SaveIdentity }
  | { status: "incompatible"; reason: "fingerprint-mismatch" }
  | { status: "damaged"; reason: "truncated" };

interface RawSaveImportRequest {
  bytes: Uint8Array;
  expectedExisting?: { identity: SaveIdentity; modifiedAt: number | null };
  modifiedAt: number | null;
  overwrite: boolean;
}

type RawSaveImportResult =
  | { status: "imported"; path: string }
  | {
    status: "conflict";
    path: string;
    existing: { identity: SaveIdentity; modifiedAt: number | null };
    incoming: { identity: SaveIdentity; modifiedAt: number | null };
  };

interface StageThreeStorageService {
  initialize(): Promise<boolean>;
  listSaves(): Promise<Array<{
    path: string;
    modifiedAt: number | null;
    status: "ready";
    identity: SaveIdentity;
  }>>;
  exportSave(path: string): Promise<Uint8Array>;
  importSave(request: RawSaveImportRequest): Promise<RawSaveImportResult>;
}

interface StageThreeStorageModule {
  createStorageService(
    module: StorageModuleHarness["module"],
    options: {
      validateSaveMetadata: (
        module: StorageModuleHarness["module"],
        path: string,
      ) => Promise<SaveValidation>;
      validateSaveBytes: (
        module: StorageModuleHarness["module"],
        bytes: Uint8Array,
      ) => Promise<SaveValidation>;
    },
  ): StageThreeStorageService;
}

const ada: SaveIdentity = {
  playerName: "Ada",
  role: "Wiz",
  race: "Hum",
  gender: "Fem",
  alignment: "Neu",
};

/** Load the stage-three service without requiring production exports at compile time. */
async function loadStorageService(): Promise<StageThreeStorageModule> {
  const implementationUrl = new URL("./storage-service.ts", import.meta.url).href;
  return import(/* @vite-ignore */ implementationUrl) as Promise<StageThreeStorageModule>;
}

/** Create and initialize one persistent service with injectable validators. */
async function createService(
  harness: StorageModuleHarness,
  validateSaveMetadata: ReturnType<typeof vi.fn<
    (
      module: StorageModuleHarness["module"],
      path: string,
    ) => Promise<SaveValidation>
  >> = vi.fn(async () => ({
    status: "ready" as const,
    identity: ada,
  })),
  validateSaveBytes: ReturnType<typeof vi.fn<
    (
      module: StorageModuleHarness["module"],
      bytes: Uint8Array,
    ) => Promise<SaveValidation>
  >> = vi.fn(async () => ({
    status: "ready" as const,
    identity: ada,
  })),
): Promise<{
  service: StageThreeStorageService;
  validateSaveBytes: typeof validateSaveBytes;
  validateSaveMetadata: typeof validateSaveMetadata;
}> {
  vi.stubGlobal("indexedDB", {});
  const { createStorageService } = await loadStorageService();
  const service = createStorageService(harness.module, {
    validateSaveMetadata,
    validateSaveBytes,
  });
  const initialization = service.initialize();
  harness.syncRequests[0].complete();
  await initialization;
  return { service, validateSaveBytes, validateSaveMetadata };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("raw save export", () => {
  it("returns an exact independent copy of a currently listed raw save", async () => {
    const harness = createStorageModuleHarness();
    const original = Uint8Array.of(0x68, 0x00, 0xff, 0x41);
    harness.files.set("/save/0Ada", original);
    const { service } = await createService(harness);

    const exported = await service.exportSave("/save/0Ada");

    expect(exported).toEqual(original);
    expect(exported).not.toBe(original);
    expect(harness.files.get("/save/0Ada")).toEqual(original);
    expect(harness.syncRequests).toHaveLength(1);
  });
});

describe("raw save import", () => {
  it("validates bytes before writing and persists under the internal player name", async () => {
    const harness = createStorageModuleHarness();
    const bytes = Uint8Array.of(0x68, 0x01, 0x02);
    const { service, validateSaveBytes } = await createService(harness);

    const importing = service.importSave({
      bytes,
      modifiedAt: 1_725_000_000_000,
      overwrite: false,
    });
    await vi.waitFor(() => expect(harness.syncRequests).toHaveLength(2));
    expect(validateSaveBytes).toHaveBeenCalledWith(harness.module, bytes);
    expect(harness.files.get("/save/0Ada")).toEqual(bytes);

    harness.syncRequests[1].complete();
    await expect(importing).resolves.toEqual({
      status: "imported",
      path: "/save/0Ada",
    });
  });

  it("returns both save summaries on conflict without touching the file system", async () => {
    const harness = createStorageModuleHarness();
    const original = Uint8Array.of(0x68, 0x10);
    harness.files.set("/save/0Ada", original);
    harness.fileModifiedAt.set("/save/0Ada", 1_700_000_000_000);
    const { service } = await createService(harness);
    vi.mocked(harness.module.FS.writeFile).mockClear();

    await expect(service.importSave({
      bytes: Uint8Array.of(0x68, 0x20),
      modifiedAt: 1_725_000_000_000,
      overwrite: false,
    })).resolves.toEqual({
      status: "conflict",
      path: "/save/0Ada",
      existing: {
        identity: ada,
        modifiedAt: 1_700_000_000_000,
      },
      incoming: {
        identity: ada,
        modifiedAt: 1_725_000_000_000,
      },
    });

    expect(harness.files.get("/save/0Ada")).toEqual(original);
    expect(harness.module.FS.writeFile).not.toHaveBeenCalled();
    expect(harness.syncRequests).toHaveLength(1);
  });

  it("requires renewed approval when an overwrite target changed", async () => {
    const harness = createStorageModuleHarness();
    harness.files.set("/save/0Ada", Uint8Array.of(0x68, 0x10));
    harness.fileModifiedAt.set("/save/0Ada", 1_725_000_000_000);
    const { service } = await createService(harness);

    const result = await service.importSave({
      bytes: Uint8Array.of(0x68, 0x20),
      expectedExisting: {
        identity: ada,
        modifiedAt: 1_700_000_000_000,
      },
      modifiedAt: null,
      overwrite: true,
    });

    expect(result).toMatchObject({
      status: "conflict",
      existing: { modifiedAt: 1_725_000_000_000 },
    });
    expect(harness.files.get("/save/0Ada")).toEqual(
      Uint8Array.of(0x68, 0x10),
    );
    expect(harness.syncRequests).toHaveLength(1);
  });

  it("rejects invalid bytes before creating a formal or temporary file", async () => {
    const harness = createStorageModuleHarness();
    const validateSaveBytes = vi.fn(async () => ({
      status: "incompatible" as const,
      reason: "fingerprint-mismatch" as const,
    }));
    const { service } = await createService(
      harness,
      vi.fn(async () => ({ status: "ready" as const, identity: ada })),
      validateSaveBytes,
    );

    await expect(service.importSave({
      bytes: Uint8Array.of(0x00),
      modifiedAt: null,
      overwrite: false,
    })).rejects.toThrow("incompatible");

    expect(harness.files.size).toBe(0);
    expect(harness.module.FS.writeFile).not.toHaveBeenCalled();
    expect(harness.syncRequests).toHaveLength(1);
  });
});
