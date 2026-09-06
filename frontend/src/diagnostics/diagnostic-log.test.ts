import { describe, expect, it, vi } from "vitest";
import {
  createDiagnosticLog,
  DIAGNOSTIC_EVENT_LIMIT,
  DIAGNOSTIC_STORAGE_KEY,
  type DiagnosticStorage,
} from "./diagnostic-log";

/** Create a deterministic in-memory localStorage replacement. */
function memoryStorage(initial?: string): DiagnosticStorage & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(DIAGNOSTIC_STORAGE_KEY, initial);
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

/** Create a log whose timestamps and error IDs are stable in assertions. */
function deterministicLog(storage: DiagnosticStorage | null = null) {
  let tick = 0;
  return createDiagnosticLog({
    productVersion: "prealpha-test",
    buildId: "build-test",
    console: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    createErrorId: () => "BH-TEST0001",
    now: () => new Date(1_700_000_000_000 + tick++),
    storage,
    userAgent: "Test Browser",
  });
}

describe("diagnostic log retention", () => {
  it("clears persisted and in-memory events as a new log generation", () => {
    const storage = memoryStorage();
    const log = deterministicLog(storage);
    log.record({ level: "info", area: "app", event: "before.clear" });

    log.clear();

    expect(log.events()).toEqual([]);
    expect(storage.values.has(DIAGNOSTIC_STORAGE_KEY)).toBe(false);
    expect(log.record({
      level: "info",
      area: "app",
      event: "after.clear",
    }).sequence).toBe(1);
  });

  it("retains the newest 500 events with stable sequence numbers", () => {
    const log = deterministicLog(memoryStorage());

    for (let index = 0; index <= DIAGNOSTIC_EVENT_LIMIT; index += 1) {
      log.record({
        level: "info",
        area: "app",
        event: "app.tick",
      });
    }

    const events = log.events();
    expect(events).toHaveLength(DIAGNOSTIC_EVENT_LIMIT);
    expect(events[0].sequence).toBe(2);
    expect(events.at(-1)?.sequence).toBe(501);
  });

  it("continues sequence numbers after restoring a persisted page", () => {
    const storage = memoryStorage();
    const first = deterministicLog(storage);
    first.record({ level: "info", area: "app", event: "app.started" });
    first.record({ level: "info", area: "wasm", event: "module.loading" });

    const restored = deterministicLog(storage);
    const event = restored.record({
      level: "info",
      area: "wasm",
      event: "module.ready",
    });

    expect(restored.events().map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(event.sequence).toBe(3);
  });

  it("ignores malformed persisted data", () => {
    const storage = memoryStorage("{not valid JSON");
    const log = deterministicLog(storage);

    expect(log.events()).toEqual([]);
    expect(log.record({
      level: "info",
      area: "app",
      event: "app.started",
    }).sequence).toBe(1);
  });
});

describe("diagnostic privacy and export", () => {
  it("drops unknown fields, error messages, and URL query text", () => {
    const log = deterministicLog();
    const detail = {
      callback: "shim_nhgetch",
      errorName: "Error",
      inputKind: "key",
      message: "Secret player Ada pressed Control+p",
      playerName: "Ada",
      stack: [
        "Error: Secret player Ada pressed Control+p",
        "    at callback (https://example.test/app.js?player=Ada:10:2)",
      ].join("\n"),
    };

    log.record({
      level: "error",
      area: "bridge",
      event: "bridge.callback_failed",
      detail: detail as never,
    });

    const exported = log.exportJson();
    expect(exported).not.toContain("Secret player");
    expect(exported).not.toContain("Control+p");
    expect(exported).not.toContain('"playerName"');
    expect(exported).not.toContain("?player=Ada");
    expect(exported).toContain("https://example.test/app.js");
  });

  it("exports parseable schema, build, browser, and event data", () => {
    const log = deterministicLog();
    log.record({ level: "info", area: "app", event: "app.started" });

    expect(JSON.parse(log.exportJson())).toMatchObject({
      schemaVersion: 1,
      productVersion: "prealpha-test",
      buildId: "build-test",
      browser: { userAgent: "Test Browser" },
      events: [{
        sequence: 1,
        area: "app",
        event: "app.started",
      }],
    });
  });

  it("records one fatal ID without exporting the raw error message", () => {
    const consoleTarget = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const log = createDiagnosticLog({
      productVersion: "prealpha-test",
      buildId: "build-test",
      console: consoleTarget,
      createErrorId: () => "BH-TEST0001",
      now: () => new Date(1_700_000_000_000),
      storage: null,
      userAgent: "Test Browser",
    });

    const fatal = log.recordFatal({
      area: "browser",
      event: "browser.unhandled_rejection",
    }, new TypeError("Secret player Ada pressed y"));

    expect(fatal.errorId).toBe("BH-TEST0001");
    expect(fatal.event).toMatchObject({
      level: "fatal",
      errorId: "BH-TEST0001",
      detail: { errorName: "TypeError" },
    });
    expect(log.exportJson()).not.toContain("Secret player Ada");
    expect(consoleTarget.error).toHaveBeenCalledWith(
      "[BlissHack][fatal][BH-TEST0001] browser.unhandled_rejection",
    );
  });

  it("records the same fatal Error object only once", () => {
    const log = deterministicLog();
    const error = new Error("one failure");

    const first = log.recordFatal({
      area: "app",
      event: "app.render_failed",
    }, error);
    const duplicate = log.recordFatal({
      area: "browser",
      event: "browser.window_error",
    }, error);

    expect(duplicate.errorId).toBe(first.errorId);
    expect(log.events()).toHaveLength(1);
  });
});

describe("diagnostic persistence fallback", () => {
  it("keeps recording in memory after localStorage throws once", () => {
    const consoleTarget = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const storage: DiagnosticStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error("quota exceeded");
      }),
    };
    const log = createDiagnosticLog({
      productVersion: "prealpha-test",
      buildId: "build-test",
      console: consoleTarget,
      now: () => new Date(1_700_000_000_000),
      storage,
    });

    log.record({ level: "info", area: "app", event: "app.started" });
    log.record({ level: "info", area: "wasm", event: "module.loading" });

    expect(log.events()).toHaveLength(2);
    expect(storage.setItem).toHaveBeenCalledOnce();
    expect(consoleTarget.warn).toHaveBeenCalledOnce();
    expect(consoleTarget.error).not.toHaveBeenCalled();
  });
});
