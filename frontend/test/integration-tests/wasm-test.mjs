/**
 * Integration test: loads the NetHack WASM module in Node.js,
 * registers the minimal shim callback, starts the game, and
 * verifies that essential shim events are received and input
 * handling works end-to-end.
 *
 * Run: npm run test:integration
 *
 * Requires: frontend/public/nethack.js and nethack.wasm
 * (built via `make CROSS_TO_WASM=1` and copied to frontend/public/)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(__dirname, "..", "..", "public");
const WASM_JS = join(WASM_DIR, "nethack.js");
const WASM_BIN = join(WASM_DIR, "nethack.wasm");

/* ------------------------------------------------------------------ */
/*  Test harness                                                       */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Minimal shim callback (mirrors nethack-bridge.ts logic)            */
/* ------------------------------------------------------------------ */

let nextWindowId = 0;
let pendingInput = null;
const receivedEventNames = new Set();
const receivedEvents = [];
let eventCount = 0;
let ynCount = 0;
const numberPadStates = [];
const ynPrompts = [];
const rawMessages = [];

globalThis.nethackGlobal = globalThis.nethackGlobal || {};

async function blissCallback(name, ...args) {
  receivedEventNames.add(name);
  receivedEvents.push(name);
  eventCount++;

  if (eventCount > 10000 && !pendingInput) {
    console.error(
      `ABORT: 10000+ events without input prompt. Unique: ${[...receivedEventNames].join(", ")}`
    );
    process.exit(1);
  }

  if (name === "shim_yn_function") {
    ynCount++;
    ynPrompts.push(String(args[0] ?? ""));
    if (ynCount > 200) {
      console.error("ABORT: shim_yn_function called 200+ times (loop?)");
      process.exit(1);
    }
    const def = typeof args[2] === "number" && args[2] > 0 ? args[2] : 121;
    return def;
  }

  switch (name) {
    case "shim_number_pad":
      numberPadStates.push(args[0]);
      return undefined;

    case "shim_raw_print":
    case "shim_raw_print_bold":
      rawMessages.push(String(args[0] ?? ""));
      return undefined;

    case "shim_create_nhwindow":
      return nextWindowId++;

    case "shim_player_selection_or_tty":
      if (globalThis.nethackGlobal?.globals?.flags) {
        const f = globalThis.nethackGlobal.globals.flags;
        f.initrole = -1; // ROLE_RANDOM
        f.initrace = -1;
        f.initgend = -1;
        f.initalign = -1;
      }
      return false;

    case "shim_askname":
      if (globalThis.nethackGlobal?.globals?.svp) {
        globalThis.nethackGlobal.globals.svp.plname = "TestPlayer";
      }
      return undefined;

    case "shim_nhgetch":
    case "shim_nh_poskey":
      return new Promise((resolve) => {
        pendingInput = resolve;
      });

    case "shim_select_menu":
      return -1; // cancel/dismiss
    case "shim_message_menu":
    case "shim_doprev_message":
      return 0;

    case "shim_get_ext_cmd":
      return -1;

    case "shim_getlin":
      return undefined;

    case "shim_getmsghistory":
    case "shim_get_color_string":
      return "";

    default:
      return undefined;
  }
}

globalThis.blissCallback = blissCallback;

/* ------------------------------------------------------------------ */
/*  Main test sequence                                                 */
/* ------------------------------------------------------------------ */

async function run() {
  console.log("=== BlissHack WASM Integration Test ===\n");

  // --- Pre-checks ---
  console.log("--- Pre-checks ---");
  assert(existsSync(WASM_JS), "nethack.js exists");
  assert(existsSync(WASM_BIN), "nethack.wasm exists");
  if (!existsSync(WASM_JS) || !existsSync(WASM_BIN)) {
    console.error("\nMissing WASM files. Build with `make CROSS_TO_WASM=1` first.");
    process.exit(1);
  }

  // --- Module loading ---
  console.log("\n--- Module loading ---");
  const factory = (await import(WASM_JS)).default;
  assert(typeof factory === "function", "WASM factory is a function");

  const module = await factory({
    noInitialRun: true,
    preRun: (runtimeModule) => {
      runtimeModule.ENV.USER = "";
      runtimeModule.ENV.LOGNAME = "";
    },
    print: () => {},
    printErr: () => {},
  });
  assert(typeof module.ccall === "function", "module.ccall exists");
  assert(typeof module.FS === "object", "module.FS exists");

  // --- Runtime settings file before main ---
  console.log("\n--- Runtime settings file before main ---");
  const runtimeRc = [
    "OPTIONS=!autopickup",
    "OPTIONS=pickup_types:$?!",
    "OPTIONS=number_pad:1",
    "OPTIONS=safe_pet",
    "OPTIONS=sortpack",
    "OPTIONS=showexp",
    "OPTIONS=time",
    "OPTIONS=!tutorial",
    "",
  ].join("\n");
  module.FS.writeFile(
    "/home/web_user/.nethackrc",
    new TextEncoder().encode(runtimeRc),
  );
  assert(
    module.FS.readFile(
      "/home/web_user/.nethackrc",
      { encoding: "utf8" },
    ) === runtimeRc,
    "runtime .nethackrc is readable before main",
  );

  // --- Stage-two save helpers before main ---
  console.log("\n--- Save helpers before main ---");
  module.ccall(
    "shim_graphics_set_restore_required",
    null,
    ["number"],
    [0],
  );
  assert(true, "shim_graphics_set_restore_required is exported");
  module.ccall(
    "shim_graphics_set_player_name",
    null,
    ["string"],
    [""],
  );
  assert(true, "shim_graphics_set_player_name is exported");
  const metadataPtr = module._malloc(256);
  const fingerprintSize = module.ccall(
    "shim_graphics_get_save_fingerprint",
    "number",
    ["number", "number"],
    [metadataPtr, 256],
  );
  module._free(metadataPtr);
  assert(
    fingerprintSize > 0 && fingerprintSize < 256,
    "shim_graphics_get_save_fingerprint works before main",
  );

  // --- Callback registration ---
  console.log("\n--- Callback registration ---");
  module.ccall("shim_graphics_set_callback", null, ["string"], ["blissCallback"]);
  assert(true, "shim_graphics_set_callback succeeded");

  // --- Game startup ---
  console.log("\n--- Game startup ---");
  receivedEventNames.clear();
  receivedEvents.length = 0;
  eventCount = 0;
  numberPadStates.length = 0;
  ynPrompts.length = 0;
  rawMessages.length = 0;

  const gamePromise = module.ccall("main", "number", [], [], { async: true });
  gamePromise.catch(() => {});

  // Wait for the game to reach the first input prompt.
  const TIMEOUT_MS = 15000;
  const start = Date.now();
  while (!pendingInput && Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // --- Startup event verification ---
  console.log(
    `\n--- Startup events (${eventCount} total, ${receivedEventNames.size} unique) ---`
  );
  assert(receivedEventNames.has("shim_init_nhwindows"), "received shim_init_nhwindows");
  assert(receivedEventNames.has("shim_askname"), "received shim_askname");
  assert(receivedEventNames.has("shim_create_nhwindow"), "received shim_create_nhwindow");
  assert(
    receivedEventNames.has("shim_player_selection_or_tty"),
    "received shim_player_selection_or_tty"
  );
  assert(receivedEventNames.has("shim_print_glyph"), "received shim_print_glyph (map render)");
  assert(receivedEventNames.has("shim_status_update"), "received shim_status_update");
  assert(
    receivedEvents.indexOf("shim_askname")
      < receivedEvents.indexOf("shim_player_selection_or_tty"),
    "asked for the player name before role selection"
  );
  assert(
    numberPadStates.includes(1),
    "number_pad from runtime .nethackrc reached the window port",
  );
  assert(
    globalThis.nethackGlobal?.globals?.flags?.showexp === true,
    "showexp from runtime .nethackrc reached NetHack globals",
  );
  assert(
    globalThis.nethackGlobal?.globals?.flags?.time === true,
    "time from runtime .nethackrc reached NetHack globals",
  );

  // --- Input handling ---
  console.log("\n--- Input handling ---");
  assert(pendingInput !== null, "game is waiting for input (shim_nh_poskey blocked)");

  if (pendingInput) {
    const countBefore = eventCount;
    pendingInput(32); // space key
    pendingInput = null;

    const start2 = Date.now();
    while (!pendingInput && Date.now() - start2 < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(
      eventCount > countBefore,
      `game processed input (${eventCount - countBefore} new events)`
    );
  }
  assert(
    !ynPrompts.some((query) => /tutorial/i.test(query)),
    "!tutorial skipped the tutorial query",
  );
  assert(
    !rawMessages.some((message) => /config|syntax|option/i.test(message)),
    "generated runtime options produced no configuration error",
  );

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
