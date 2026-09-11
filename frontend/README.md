# BlissHack Frontend

React and TypeScript frontend for the NetHack WebAssembly build.

## Architecture

- `src/App.tsx` composes the application state machine and screens.
- `src/app/app-state.ts` owns top-level UI lifecycle state.
- `src/session/session-manager.ts` is the stable session API facade.
- `src/session/session-lifecycle.ts` owns module and active-session lifecycle.
- `src/session/home-operations.ts` owns Home save, backup, and data operations.
- `src/nethack-bridge.ts` is the stable shim callback facade.
- `src/bridge/` contains Emscripten loading, WASM decoding, save validation,
  and the single input controller.
- `src/screens/settings/` and `src/screens/game/` contain screen-owned
  presentation components.
- `src/styles/` contains page-scoped global styles loaded through `src/App.css`.

The checked-in `public/nethack.js`, `public/nethack.wasm`, and
`public/nethack-runtime.json` files form one verified runtime triplet. Follow
the repository [WASM build process](../doc/BlissHack/build-process.md) before
changing them.

## Development

Install dependencies and start Vite:

```sh
npm ci
npm run dev
```

Run the standard checks:

```sh
npm run lint
npm test
npm run build
npm run test:integration
npm run test:integration:compat
npm run test:performance
npm run test:long
```

Install the browser binaries once before running Playwright:

```sh
npx playwright install chromium firefox webkit
```

## GitHub Pages

The deployment workflow builds this directory and publishes `dist`. It derives
the Vite base path from the repository name.

```sh
VITE_BASE_PATH=/BlissHack/ npm run build
VITE_BASE_PATH=/BlissHack/ npm run preview
```
