import { describe, expect, it, vi } from "vitest";
import {
  createGameLock,
  GAME_LOCK_NAME,
  GameLockConflictError,
  GameLockRequestError,
  type BrowserLockManager,
} from "./game-lock";

/** Return a minimal exclusive lock fixture. */
function heldLock() {
  return { mode: "exclusive" as const, name: GAME_LOCK_NAME };
}

describe("game lock", () => {
  it("runs a short operation under the fixed exclusive lock", async () => {
    const callback = vi.fn(async () => "done");
    const request = vi.fn(async (
      name: string,
      options: { ifAvailable: true; mode: "exclusive" },
      lockCallback: (lock: ReturnType<typeof heldLock>) => Promise<string>,
    ) => {
      expect(name).toBe(GAME_LOCK_NAME);
      expect(options).toEqual({ ifAvailable: true, mode: "exclusive" });
      return lockCallback(heldLock());
    });
    const lock = createGameLock({ request } as BrowserLockManager);

    await expect(lock.runExclusive("raw-save-export", callback))
      .resolves.toBe("done");
    expect(callback).toHaveBeenCalledOnce();
  });

  it("reports contention without invoking the protected operation", async () => {
    const callback = vi.fn(async () => undefined);
    const manager: BrowserLockManager = {
      request: async (_name, _options, lockCallback) => lockCallback(null),
    };
    const lock = createGameLock(manager);

    await expect(lock.runExclusive("new-game", callback))
      .rejects.toBeInstanceOf(GameLockConflictError);
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps a lease held until release and releases it once", async () => {
    let callbackSettled = false;
    const manager: BrowserLockManager = {
      request: async (_name, _options, lockCallback) => {
        const result = await lockCallback(heldLock());
        callbackSettled = true;
        return result;
      },
    };
    const lock = createGameLock(manager);
    const lease = await lock.acquireLease("new-game");

    expect(callbackSettled).toBe(false);
    await lease.release();
    expect(callbackSettled).toBe(true);
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("distinguishes request failures from protected callback failures", async () => {
    const requestFailure = new Error("request failed");
    const requestLock = createGameLock({
      request: async () => {
        throw requestFailure;
      },
    });
    await expect(requestLock.runExclusive(
      "profile-save",
      async () => undefined,
    )).rejects.toBeInstanceOf(GameLockRequestError);

    const operationFailure = new Error("operation failed");
    const operationLock = createGameLock({
      request: async (_name, _options, callback) =>
        callback(heldLock()),
    });
    await expect(operationLock.runExclusive(
      "profile-save",
      async () => {
        throw operationFailure;
      },
    )).rejects.toBe(operationFailure);
  });

  it("preserves single-page behavior without Web Locks", async () => {
    const callback = vi.fn(async () => 42);
    const lock = createGameLock(null);

    expect(lock.supported).toBe(false);
    await expect(lock.runExclusive("full-backup-export", callback))
      .resolves.toBe(42);
    const lease = await lock.acquireLease("new-game");
    await expect(lease.release()).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledOnce();
  });
});
