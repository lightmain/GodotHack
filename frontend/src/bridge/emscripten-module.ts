import { ATR_BOLD, appendWindowText } from "../game-state";

/** Emscripten filesystem surface used by DLB access and save persistence. */
export interface EmscriptenFileSystem {
  analyzePath(path: string): { exists: boolean };
  mkdir(path: string): unknown;
  mount(type: unknown, options: Record<string, unknown>, path: string): unknown;
  readFile(
    path: string,
    options?: { encoding: "utf8" },
  ): string | Uint8Array;
  syncfs(
    populate: boolean,
    callback: (error: unknown | null) => void,
  ): void;
}

/** Emscripten module APIs required by the shim bridge. */
export interface EmscriptenModule {
  ccall(
    name: string,
    returnType: string | null,
    argumentTypes: string[],
    arguments_: unknown[],
    options?: { async: boolean },
  ): unknown;
  getValue(ptr: number, type: string): number | bigint;
  setValue(ptr: number, value: number, type: string): void;
  UTF8ToString(ptr: number): string;
  stringToUTF8(value: string, ptr: number, maxBytes: number): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  ENV?: Record<string, string>;
  FS: EmscriptenFileSystem;
  IDBFS?: unknown;
}

interface NethackGlobals {
  svp?: { plname?: string };
  iflags?: {
    wc2_hitpointbar?: boolean;
    window_inited?: boolean;
  };
  flags?: {
    initrole?: number;
    initrace?: number;
    initgend?: number;
    initalign?: number;
  };
}

interface NethackGlobal {
  globals?: NethackGlobals;
  pointers?: { extcmdlist?: number };
}

declare global {
  var nethackGlobal: NethackGlobal | undefined;
}

export type EmscriptenFactory = (
  options: Record<string, unknown>,
) => Promise<EmscriptenModule>;

/** Session guard used while a module factory is still loading asynchronously. */
export interface GameModuleOptions {
  isCurrent?: () => boolean;
}

/**
 * Remove Emscripten's synthetic login name before NetHack calls whoami().
 * This makes plnamesuffix() invoke askname before save lookup and role selection.
 */
export function preparePlayerNamePrompt(module: EmscriptenModule): void {
  module.ENV ??= {};
  module.ENV.USER = "";
  module.ENV.LOGNAME = "";
}

/** Load one fresh NetHack module without registering callbacks or running main. */
export async function createGameModule(
  wasmUrl = `${import.meta.env.BASE_URL}nethack.js`,
  options: GameModuleOptions = {},
): Promise<EmscriptenModule> {
  const isCurrent = options.isCurrent ?? (() => true);
  const loaderUrl = new URL(wasmUrl, globalThis.location.href).href;
  const imported = await import(/* @vite-ignore */ loaderUrl) as {
    default: EmscriptenFactory;
  };
  return imported.default({
    noInitialRun: true,
    locateFile: (path: string) => new URL(path, loaderUrl).href,
    preRun: (runtimeModule: EmscriptenModule) =>
      preparePlayerNamePrompt(runtimeModule),
    print: (text: string) => {
      if (isCurrent()) appendWindowText(-1, 0, text);
    },
    printErr: (text: string) => {
      if (isCurrent()) appendWindowText(-1, ATR_BOLD, text);
    },
  });
}
