import { describe, expect, it, vi } from "vitest";
import { createPersistenceAdapter } from "./persistence";

describe("browser persistent storage adapter", () => {
  it.each([
    [true, "persistent"],
    [false, "not-persistent"],
  ] as const)("maps persisted %s to %s", async (value, expected) => {
    const adapter = createPersistenceAdapter({
      persisted: vi.fn(async () => value),
    });

    await expect(adapter.query()).resolves.toBe(expected);
  });

  it.each([
    [true, "granted"],
    [false, "denied"],
  ] as const)("maps persist %s to %s", async (value, expected) => {
    const adapter = createPersistenceAdapter({
      persist: vi.fn(async () => value),
    });

    await expect(adapter.request()).resolves.toBe(expected);
  });

  it("reports unsupported methods without throwing", async () => {
    const adapter = createPersistenceAdapter({});

    await expect(adapter.query()).resolves.toBe("unsupported");
    await expect(adapter.request()).resolves.toBe("unsupported");
  });

  it("reports rejected browser operations as errors", async () => {
    const adapter = createPersistenceAdapter({
      persisted: vi.fn(async () => {
        throw new Error("blocked");
      }),
      persist: vi.fn(async () => {
        throw new Error("blocked");
      }),
    });

    await expect(adapter.query()).resolves.toBe("error");
    await expect(adapter.request()).resolves.toBe("error");
  });
});
