import type {
  SaveValidation,
  StorageModule,
} from "../storage/storage-service";
import type { EmscriptenModule } from "./emscripten-module";

/**
 * Validate a save with NetHack's own header reader and return its identity.
 * @param storageModule - module which owns the save file.
 * @param path - absolute virtual save path.
 * @returns a ready identity or an explicit invalid result.
 */
export async function validateSaveMetadata(
  storageModule: StorageModule,
  path: string,
): Promise<SaveValidation> {
  const fileData = storageModule.FS.readFile(path);
  if (typeof fileData === "string") {
    return { status: "damaged", reason: "not-binary" };
  }
  const validation = await validateSaveBytes(storageModule, fileData);
  if (validation.status !== "ready") return validation;

  const fileName = path.slice(path.lastIndexOf("/") + 1);
  if (fileName !== `0${validation.identity.playerName}`) {
    return {
      status: "damaged",
      reason: "identity-file-name-mismatch",
    };
  }
  return validation;
}

/**
 * Validate raw save bytes before they are allowed into the formal save path.
 * @param storageModule - module which supplies the current build fingerprint.
 * @param fileData - untrusted uploaded bytes.
 * @returns a ready identity or an explicit invalid result.
 */
export async function validateSaveBytes(
  storageModule: StorageModule,
  fileData: Uint8Array,
): Promise<SaveValidation> {
  const module = storageModule as unknown as EmscriptenModule;
  const outputSize = 256;
  const outputPtr = module._malloc(outputSize);
  try {
    const fingerprintSize = Number(module.ccall(
      "shim_graphics_get_save_fingerprint",
      "number",
      ["number", "number"],
      [outputPtr, outputSize],
    ));
    if (
      !Number.isInteger(fingerprintSize)
      || fingerprintSize <= 0
      || fingerprintSize > outputSize
    ) {
      throw new Error("Current save fingerprint is unavailable");
    }

    if (fileData.length < fingerprintSize + 4 + 49) {
      return { status: "damaged", reason: "truncated" };
    }
    for (let index = 0; index < fingerprintSize; index += 1) {
      if (
        fileData[index]
        !== (Number(module.getValue(outputPtr + index, "i8")) & 0xff)
      ) {
        return {
          status: "incompatible",
          reason: "fingerprint-mismatch",
        };
      }
    }

    const identitySize = new DataView(
      fileData.buffer,
      fileData.byteOffset + fingerprintSize,
      4,
    ).getInt32(0, true);
    if (identitySize !== 49) {
      return { status: "damaged", reason: "invalid-identity-size" };
    }
    const identity = fileData.subarray(
      fingerprintSize + 4,
      fingerprintSize + 4 + identitySize,
    );
    const nameEnd = identity.indexOf(0);
    if (nameEnd <= 0) {
      return { status: "damaged", reason: "invalid-player-name" };
    }
    const detailsEnd = identity.indexOf(0, nameEnd + 1);
    if (detailsEnd <= nameEnd + 1) {
      return {
        status: "damaged",
        reason: "invalid-character-identity",
      };
    }
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const playerName = decoder.decode(identity.subarray(0, nameEnd));
      const details = decoder.decode(
        identity.subarray(nameEnd + 1, detailsEnd),
      ).split("-");
      if (
        !playerName
        || details.length !== 4
        || details.some((value) => !/^[A-Za-z]{3}$/.test(value))
      ) {
        return {
          status: "damaged",
          reason: "invalid-character-identity",
        };
      }
      const [role, race, gender, alignment] = details;
      return {
        status: "ready",
        identity: { playerName, role, race, gender, alignment },
      };
    } catch {
      return {
        status: "damaged",
        reason: "invalid-character-identity",
      };
    }
  } finally {
    module._free(outputPtr);
  }
}
