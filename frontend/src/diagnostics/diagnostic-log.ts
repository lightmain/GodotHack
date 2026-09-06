import { BUILD_ID, PRODUCT_VERSION } from "../version";

/** Maximum number of diagnostic events retained across page loads. */
export const DIAGNOSTIC_EVENT_LIMIT = 500;
/** Browser-local key for the persisted diagnostic log. */
export const DIAGNOSTIC_STORAGE_KEY = "blisshack.diagnostics.v1";

export type DiagnosticLevel = "info" | "warning" | "error" | "fatal";
export type DiagnosticArea =
  | "app"
  | "session"
  | "wasm"
  | "bridge"
  | "storage"
  | "browser";

/** Fixed diagnostic fields which cannot contain gameplay text or save data. */
export interface DiagnosticDetail {
  buildId?: string;
  callback?: string;
  errorName?: string;
  failedCount?: number;
  importedCount?: number;
  inputKind?: string | null;
  saveCount?: number;
  skippedCount?: number;
  stack?: string;
  storageAvailable?: boolean;
}

/** One low-frequency application lifecycle or failure record. */
export interface DiagnosticEvent {
  sequence: number;
  timestamp: string;
  level: DiagnosticLevel;
  area: DiagnosticArea;
  event: string;
  errorId: string | null;
  moduleId: string | null;
  sessionId: string | null;
  detail?: DiagnosticDetail;
}

/** Fields supplied by a caller before sequence and timestamp are assigned. */
export interface DiagnosticEventInput {
  level: DiagnosticLevel;
  area: DiagnosticArea;
  event: string;
  errorId?: string | null;
  moduleId?: string | null;
  sessionId?: string | null;
  detail?: DiagnosticDetail;
}

/** Portable JSON document downloaded by the player. */
export interface DiagnosticExport {
  schemaVersion: 1;
  productVersion: string;
  buildId: string;
  exportedAt: string;
  browser: {
    userAgent: string;
  };
  events: DiagnosticEvent[];
}

/** Minimum browser storage contract needed by the diagnostic log. */
export interface DiagnosticStorage {
  getItem(key: string): string | null;
  removeItem?(key: string): void;
  setItem(key: string, value: string): void;
}

/** Console methods used for warning and failure mirroring. */
export interface DiagnosticConsole {
  warn(message: string): void;
  error(message: string): void;
}

/** Injectable dependencies for deterministic tests and browser integration. */
export interface DiagnosticLogOptions {
  productVersion: string;
  buildId: string;
  console?: DiagnosticConsole;
  createErrorId?: () => string;
  now?: () => Date;
  storage?: DiagnosticStorage | null;
  userAgent?: string;
}

/** Public operations for recording and exporting diagnostics. */
export interface DiagnosticLog {
  productVersion: string;
  buildId: string;
  record(input: DiagnosticEventInput): DiagnosticEvent;
  recordFatal(
    input: Omit<DiagnosticEventInput, "errorId" | "level">,
    error: unknown,
  ): { errorId: string; event: DiagnosticEvent };
  events(): DiagnosticEvent[];
  clear(): void;
  exportData(): DiagnosticExport;
  exportJson(): string;
}

interface PersistedDiagnosticLog {
  schemaVersion: 1;
  nextSequence: number;
  events: DiagnosticEvent[];
}

let fallbackErrorId = 0;
let browserDiagnosticLog: DiagnosticLog | null = null;

/**
 * Create an isolated diagnostic log with optional browser persistence.
 * @param options - build metadata and replaceable platform dependencies.
 * @returns bounded diagnostic recorder and exporter.
 */
export function createDiagnosticLog(
  options: DiagnosticLogOptions,
): DiagnosticLog {
  const now = options.now ?? (() => new Date());
  const createErrorId = options.createErrorId ?? defaultErrorId;
  const output = options.console ?? console;
  const productVersion = normalizeToken(
    options.productVersion,
    64,
    "unknown",
  );
  const buildId = normalizeToken(options.buildId, 128, "development");
  let storage = options.storage ?? null;
  const restored = restorePersistedLog(storage);
  let records = restored.events;
  let nextSequence = restored.nextSequence;
  const recordedFatalErrors = new WeakMap<
    object,
    { errorId: string; event: DiagnosticEvent }
  >();

  /** Persist the complete bounded log or permanently fall back to memory. */
  function persist(): void {
    if (!storage) return;
    try {
      const value: PersistedDiagnosticLog = {
        schemaVersion: 1,
        nextSequence,
        events: records,
      };
      storage.setItem(DIAGNOSTIC_STORAGE_KEY, JSON.stringify(value));
    } catch {
      storage = null;
      output.warn(
        "[BlissHack][warning] diagnostics.persistence_unavailable",
      );
    }
  }

  /** Append one sanitized event and mirror only warnings and failures. */
  function record(input: DiagnosticEventInput): DiagnosticEvent {
    const event = normalizeNewEvent(input, nextSequence, now());
    nextSequence += 1;
    records = [...records, event].slice(-DIAGNOSTIC_EVENT_LIMIT);
    persist();
    mirrorToConsole(output, event);
    return cloneEvent(event);
  }

  /** Generate one correlation ID and record a privacy-filtered fatal event. */
  function recordFatal(
    input: Omit<DiagnosticEventInput, "errorId" | "level">,
    error: unknown,
  ): { errorId: string; event: DiagnosticEvent } {
    if (isObject(error)) {
      const existing = recordedFatalErrors.get(error);
      if (existing) {
        return { errorId: existing.errorId, event: cloneEvent(existing.event) };
      }
    }
    const errorId = normalizeToken(createErrorId(), 48, "BH-UNKNOWN");
    const suppliedDetail = input.detail ?? {};
    const event = record({
      ...input,
      level: "fatal",
      errorId,
      detail: {
        ...suppliedDetail,
        ...errorDetail(error),
      },
    });
    const fatal = { errorId, event };
    if (isObject(error)) recordedFatalErrors.set(error, fatal);
    return { errorId, event: cloneEvent(event) };
  }

  /** Return a detached event list which callers cannot mutate in place. */
  function events(): DiagnosticEvent[] {
    return records.map(cloneEvent);
  }

  /** Delete prior persisted and in-memory events after explicit user confirmation. */
  function clear(): void {
    records = [];
    nextSequence = 1;
    if (!storage) return;
    if (!storage.removeItem) {
      throw new Error("Diagnostic storage cannot be cleared");
    }
    storage.removeItem(DIAGNOSTIC_STORAGE_KEY);
  }

  /** Build the versioned portable diagnostic document. */
  function exportData(): DiagnosticExport {
    return {
      schemaVersion: 1,
      productVersion,
      buildId,
      exportedAt: now().toISOString(),
      browser: {
        userAgent: truncate(options.userAgent ?? "unknown", 512),
      },
      events: events(),
    };
  }

  return {
    productVersion,
    buildId,
    record,
    recordFatal,
    events,
    clear,
    exportData,
    exportJson: () => JSON.stringify(exportData(), null, 2),
  };
}

/**
 * Return the single browser diagnostic log used by the application.
 * @returns lazily initialized browser-backed diagnostic log.
 */
export function getBrowserDiagnosticLog(): DiagnosticLog {
  if (browserDiagnosticLog) return browserDiagnosticLog;
  browserDiagnosticLog = createDiagnosticLog({
    productVersion: PRODUCT_VERSION,
    buildId: BUILD_ID,
    storage: browserStorage(),
    userAgent: globalThis.navigator?.userAgent ?? "unknown",
  });
  return browserDiagnosticLog;
}

/** Read a valid persisted log without trusting arbitrary stored fields. */
function restorePersistedLog(storage: DiagnosticStorage | null): {
  events: DiagnosticEvent[];
  nextSequence: number;
} {
  if (!storage) return { events: [], nextSequence: 1 };
  try {
    const raw = storage.getItem(DIAGNOSTIC_STORAGE_KEY);
    if (!raw) return { events: [], nextSequence: 1 };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
      return { events: [], nextSequence: 1 };
    }
    const sourceEvents = Array.isArray(parsed.events) ? parsed.events : [];
    const events = sourceEvents
      .map(normalizeStoredEvent)
      .filter((event): event is DiagnosticEvent => event !== null)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-DIAGNOSTIC_EVENT_LIMIT);
    const largestSequence = events.at(-1)?.sequence ?? 0;
    const persistedNext = finitePositiveInteger(parsed.nextSequence);
    return {
      events,
      nextSequence: Math.max(largestSequence + 1, persistedNext ?? 1),
    };
  } catch {
    return { events: [], nextSequence: 1 };
  }
}

/** Normalize a newly supplied event using the same persisted-data policy. */
function normalizeNewEvent(
  input: DiagnosticEventInput,
  sequence: number,
  timestamp: Date,
): DiagnosticEvent {
  const event: DiagnosticEvent = {
    sequence,
    timestamp: timestamp.toISOString(),
    level: input.level,
    area: input.area,
    event: normalizeToken(input.event, 96, "diagnostics.unknown"),
    errorId: nullableToken(input.errorId, 48),
    moduleId: nullableToken(input.moduleId, 128),
    sessionId: nullableToken(input.sessionId, 128),
  };
  const detail = normalizeDetail(input.detail);
  if (detail) event.detail = detail;
  return event;
}

/** Accept only complete, bounded events from a previous browser page. */
function normalizeStoredEvent(value: unknown): DiagnosticEvent | null {
  if (!isRecord(value)) return null;
  const sequence = finitePositiveInteger(value.sequence);
  if (
    sequence === null
    || typeof value.timestamp !== "string"
    || !Number.isFinite(Date.parse(value.timestamp))
    || !isDiagnosticLevel(value.level)
    || !isDiagnosticArea(value.area)
    || typeof value.event !== "string"
  ) {
    return null;
  }
  return normalizeNewEvent({
    level: value.level,
    area: value.area,
    event: value.event,
    errorId: typeof value.errorId === "string" ? value.errorId : null,
    moduleId: typeof value.moduleId === "string" ? value.moduleId : null,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    detail: isRecord(value.detail) ? value.detail as DiagnosticDetail : undefined,
  }, sequence, new Date(value.timestamp));
}

/** Retain only the fixed detail fields and their safe value shapes. */
function normalizeDetail(value: DiagnosticDetail | undefined):
  DiagnosticDetail | undefined {
  if (!value || !isRecord(value)) return undefined;
  const detail: DiagnosticDetail = {};
  if (typeof value.buildId === "string") {
    detail.buildId = normalizeToken(value.buildId, 128, "development");
  }
  if (typeof value.callback === "string") {
    detail.callback = normalizeToken(value.callback, 96, "redacted");
  }
  if (typeof value.errorName === "string") {
    detail.errorName = normalizeToken(value.errorName, 80, "Error");
  }
  if (value.inputKind === null) detail.inputKind = null;
  else if (typeof value.inputKind === "string") {
    detail.inputKind = normalizeToken(value.inputKind, 32, "unknown");
  }
  const saveCount = finiteNonNegativeInteger(value.saveCount);
  if (saveCount !== null) detail.saveCount = saveCount;
  const importedCount = finiteNonNegativeInteger(value.importedCount);
  if (importedCount !== null) detail.importedCount = importedCount;
  const skippedCount = finiteNonNegativeInteger(value.skippedCount);
  if (skippedCount !== null) detail.skippedCount = skippedCount;
  const failedCount = finiteNonNegativeInteger(value.failedCount);
  if (failedCount !== null) detail.failedCount = failedCount;
  if (typeof value.stack === "string") {
    const stack = sanitizeStack(value.stack);
    if (stack) detail.stack = stack;
  }
  if (typeof value.storageAvailable === "boolean") {
    detail.storageAvailable = value.storageAvailable;
  }
  return Object.keys(detail).length === 0 ? undefined : detail;
}

/** Extract an error type and code locations without preserving its message. */
function errorDetail(error: unknown): DiagnosticDetail {
  if (!(error instanceof Error)) {
    return { errorName: "UnknownError" };
  }
  const detail: DiagnosticDetail = {
    errorName: normalizeToken(error.name || "Error", 80, "Error"),
  };
  const stack = sanitizeStack(error.stack ?? "");
  if (stack) detail.stack = stack;
  return detail;
}

/** Keep at most ten stack-frame lines and discard the message-bearing line. */
function sanitizeStack(stack: string): string {
  return stack
    .split(/\r?\n/)
    .filter((line) => /^\s*at\s+/.test(line))
    .slice(0, 10)
    .map((line) => truncate(stripUrlQuery(line.trim()), 300))
    .join("\n")
    .slice(0, 3_000);
}

/** Remove URL query and fragment text which may contain test or player input. */
function stripUrlQuery(value: string): string {
  return value.replace(
    /(https?:\/\/[^\s)?#]+)[?#][^\s)]*/g,
    "$1",
  );
}

/** Mirror only degraded or failed events to the developer console. */
function mirrorToConsole(
  output: DiagnosticConsole,
  event: DiagnosticEvent,
): void {
  if (event.level === "info") return;
  const errorId = event.errorId ? `[${event.errorId}]` : "";
  const message =
    `[BlissHack][${event.level}]${errorId} ${event.event}`;
  if (event.level === "warning") output.warn(message);
  else output.error(message);
}

/** Resolve localStorage without letting access-policy errors escape. */
function browserStorage(): DiagnosticStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Generate a non-sensitive short identifier for one fatal event. */
function defaultErrorId(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?.replaceAll("-", "")
    .slice(0, 8)
    .toUpperCase();
  if (random) return `BH-${random}`;
  fallbackErrorId += 1;
  return `BH-${fallbackErrorId.toString(36).toUpperCase().padStart(8, "0")}`;
}

/** Return a detached event and detail object. */
function cloneEvent(event: DiagnosticEvent): DiagnosticEvent {
  return {
    ...event,
    ...(event.detail ? { detail: { ...event.detail } } : {}),
  };
}

/** Normalize an identifier-like field to a bounded non-sensitive token. */
function normalizeToken(
  value: string,
  maxLength: number,
  fallback: string,
): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, "_");
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

/** Normalize an optional token and convert missing values to null. */
function nullableToken(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  return typeof value === "string"
    ? normalizeToken(value, maxLength, "unknown")
    : null;
}

/** Limit one exported browser metadata value. */
function truncate(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}

/** Narrow an unknown JSON value to a string-keyed object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return whether an unknown value can be used as a WeakMap identity. */
function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Return a finite positive integer or null. */
function finitePositiveInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : null;
}

/** Return a finite non-negative integer or null. */
function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

/** Narrow an unknown value to a supported diagnostic level. */
function isDiagnosticLevel(value: unknown): value is DiagnosticLevel {
  return value === "info"
    || value === "warning"
    || value === "error"
    || value === "fatal";
}

/** Narrow an unknown value to a supported diagnostic area. */
function isDiagnosticArea(value: unknown): value is DiagnosticArea {
  return value === "app"
    || value === "session"
    || value === "wasm"
    || value === "bridge"
    || value === "storage"
    || value === "browser";
}
