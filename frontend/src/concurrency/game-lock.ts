/** Cross-page lock shared by game sessions and persistent-data operations. */
export const GAME_LOCK_NAME = "blisshack.active-game-and-storage";

/** Stable operation names recorded without user data. */
export type GameLockOperation =
  | "new-game"
  | "continue-game"
  | "raw-save-import"
  | "raw-save-export"
  | "raw-save-delete"
  | "profile-save"
  | "profile-import"
  | "profile-export"
  | "full-backup-preview"
  | "full-backup-import"
  | "full-backup-export"
  | "clear-local-data";

interface BrowserLock {
  readonly mode: "exclusive" | "shared";
  readonly name: string;
}

/** Minimum Web Locks contract used by the application and tests. */
export interface BrowserLockManager {
  request<T>(
    name: string,
    options: { ifAvailable: true; mode: "exclusive" },
    callback: (lock: BrowserLock | null) => Promise<T> | T,
  ): Promise<T>;
}

/** A long-lived exclusive lock released by the owning game session. */
export interface GameLockLease {
  release(): Promise<void>;
}

/** Browser-independent lock operations consumed by the session manager. */
export interface GameLock {
  readonly supported: boolean;
  acquireLease(operation: GameLockOperation): Promise<GameLockLease>;
  runExclusive<T>(
    operation: GameLockOperation,
    callback: () => Promise<T>,
  ): Promise<T>;
}

/** Another page currently owns the BlissHack game and storage lock. */
export class GameLockConflictError extends Error {
  readonly operation: GameLockOperation;

  constructor(operation: GameLockOperation) {
    super("Another BlissHack page is using the game or local data");
    this.name = "GameLockConflictError";
    this.operation = operation;
  }
}

/** The browser exposed Web Locks but failed to process a lock request. */
export class GameLockRequestError extends Error {
  readonly operation: GameLockOperation;

  constructor(operation: GameLockOperation, cause: unknown) {
    super("The browser could not request the BlissHack game lock", { cause });
    this.name = "GameLockRequestError";
    this.operation = operation;
  }
}

/** The player cancelled a pending retry after a lock conflict. */
export class GameLockCancelledError extends Error {
  constructor() {
    super("The locked operation was cancelled");
    this.name = "GameLockCancelledError";
  }
}

/**
 * Create the cross-page lock adapter.
 * @param manager - optional browser LockManager-compatible implementation.
 * @returns short-operation and session-lease locking operations.
 */
export function createGameLock(
  manager: BrowserLockManager | null = browserLockManager(),
): GameLock {
  if (!manager) return unsupportedGameLock();

  return {
    supported: true,

    async runExclusive<T>(
      operation: GameLockOperation,
      callback: () => Promise<T>,
    ): Promise<T> {
      let callbackEntered = false;
      try {
        return await manager.request(
          GAME_LOCK_NAME,
          { ifAvailable: true, mode: "exclusive" },
          async (lock) => {
            callbackEntered = true;
            if (!lock) throw new GameLockConflictError(operation);
            return callback();
          },
        );
      } catch (error) {
        if (callbackEntered) throw error;
        throw new GameLockRequestError(operation, error);
      }
    },

    async acquireLease(
      operation: GameLockOperation,
    ): Promise<GameLockLease> {
      let callbackEntered = false;
      let acquiredResolve!: () => void;
      let acquiredReject!: (error: unknown) => void;
      let releaseResolve!: () => void;
      let released = false;
      const acquired = new Promise<void>((resolve, reject) => {
        acquiredResolve = resolve;
        acquiredReject = reject;
      });
      const hold = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });

      const request = Promise.resolve()
        .then(() =>
          manager.request(
            GAME_LOCK_NAME,
            { ifAvailable: true, mode: "exclusive" },
            async (lock) => {
              callbackEntered = true;
              if (!lock) {
                throw new GameLockConflictError(operation);
              }
              acquiredResolve();
              await hold;
            },
          ))
        .catch((error: unknown) => {
          const failure = callbackEntered
            ? error
            : new GameLockRequestError(operation, error);
          acquiredReject(failure);
          throw failure;
        });
      void request.catch(() => undefined);

      await acquired;
      return {
        async release(): Promise<void> {
          if (!released) {
            released = true;
            releaseResolve();
          }
          await request;
        },
      };
    },
  };
}

/** Resolve the browser LockManager without throwing on restricted globals. */
function browserLockManager(): BrowserLockManager | null {
  try {
    const locks = globalThis.navigator?.locks;
    return locks && typeof locks.request === "function"
      ? locks as unknown as BrowserLockManager
      : null;
  } catch {
    return null;
  }
}

/** Preserve existing single-page behavior when Web Locks is unavailable. */
function unsupportedGameLock(): GameLock {
  return {
    supported: false,
    async acquireLease(): Promise<GameLockLease> {
      return { release: async () => undefined };
    },
    async runExclusive<T>(
      _operation: GameLockOperation,
      callback: () => Promise<T>,
    ): Promise<T> {
      return callback();
    },
  };
}
