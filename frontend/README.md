# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

## Tests

Install the Playwright browsers once:

```sh
npx playwright install chromium firefox webkit
```

Run unit tests:

```sh
npm test
```

Run the WASM and browser integration suites:

```sh
npm run test:integration
```

Run the manual-release Firefox and WebKit basic flows:

```sh
npm run test:integration:compat
```

Run the permanent-inventory performance regression:

```sh
npm run test:performance
```

Run the release-oriented long browser flows:

```sh
npm run test:long
```

## GitHub Pages

The deployment workflow builds this directory and publishes `dist`. It derives
the Vite base path from the GitHub repository name, so a repository named
`BlissHack` is served from `/BlissHack/`.

To reproduce that build locally:

```sh
VITE_BASE_PATH=/BlissHack/ npm run build
VITE_BASE_PATH=/BlissHack/ npm run preview
```

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
