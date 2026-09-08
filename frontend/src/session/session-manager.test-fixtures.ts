import type { GameLock } from "../concurrency/game-lock";

/**
 * Create a per-test lock which preserves single-page behavior without touching
 * the runtime's process-global Web Locks implementation.
 * @returns isolated lock dependency for ordinary session-manager tests.
 */
export function createIsolatedGameLock(): GameLock {
  return {
    supported: false,
    async acquireLease() {
      return {
        async release() {
          return undefined;
        },
      };
    },
    async runExclusive(_operation, callback) {
      return callback();
    },
  };
}
