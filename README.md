# BlissHack

[English](README.md) | [简体中文](README-cn.md)

> **Upstream and license notice**
>
> BlissHack is an unofficial modified distribution of NetHack 5.0.0. The
> original NetHack README is preserved unchanged as
> [README-NetHack](README-NetHack). NetHack's license is preserved in
> [dat/license](dat/license). BlissHack is not produced or supported by the
> NetHack DevTeam; issues specific to this browser frontend should be reported
> to this project rather than upstream.

BlissHack runs a more modern NetHack experience in a web
browser. The NetHack C core is compiled to WebAssembly and connected to a
React/TypeScript terminal through the upstream shim window interface.
BlissHack makes a small number of targeted changes to the NetHack C code,
primarily to fix missing shim interface behavior required by the browser
frontend. These changes are documented in
[Current project modifications to the shim interface](doc/BlissHack/shim-interface-reference.md#6-当前项目对-shim-接口的修改).

## Project Status

**prealpha-3 is complete and prealpha-4 is in development.**

prealpha-4 is a smaller, refactoring-only milestone. It will add no
player-facing features and will focus on splitting large frontend files,
clarifying module ownership, and reducing the context needed for future changes.

The current milestone provides:

- A playable 80x21 character map with NetHack colors, cursor, pets, and
  background glyphs.
- Message history, text windows, menus, prompts, extended commands, and
  position input.
- Character naming followed by the original role, race, gender, and alignment
  selection flow.
- A multi-line status display with a color-coded HP bar behind the character
  name and title.
- Accurate ASCII, Control, Alt/Meta, direction, and numeric keypad input.
- Browser-local save and restore through Emscripten IDBFS.
- Unit, WASM integration, and Chromium browser integration tests.
- Automated deployment to GitHub Pages.

This is still a pre-alpha release. Save compatibility, UI details, and
window-port coverage may change before a stable release.

## Play Online

<https://lightmain.github.io/BlissHack/>

Saved games are stored in the current browser profile. They are not uploaded
to a server and do not automatically move between browsers or devices.

The Home footer and fatal-error screen can export the local diagnostic log.
The log is never uploaded automatically and excludes player names, keys,
game messages, and save contents.

## Controls

BlissHack uses NetHack's standard keyboard commands:

- Arrow keys or `h`, `j`, `k`, `l` move the character.
- `Ctrl` combinations are encoded as ASCII control characters.
- `Alt` combinations produce NetHack Meta commands.
- The operating-system `Command`/`Meta` key is left to the browser.
- Numeric keypad input follows NetHack's active number-pad mode.

See [the key input reference](doc/BlissHack/key-input-reference.md) for the
complete encoding table and source references.

## Local Development

The product version is defined by the root `VERSION` file. Frontend
development and CI use the Node.js major version selected by the root
`.nvmrc`.

The checked-in `frontend/public/nethack.js`, `nethack.wasm`, and
`nethack-runtime.json` files are the Emscripten runtime triplet used by the
frontend.

```sh
cd frontend
npm ci
npm run dev
```

Production build:

```sh
cd frontend
npm run build
npm run preview
```

Rebuilding the WebAssembly core requires the pinned Emscripten version.
Follow the [WASM build process](doc/BlissHack/build-process.md) and always
commit both runtime files and their verification manifest together.

## Tests

```sh
cd frontend
npm test
npm run lint
npm run test:integration
npm run test:long
```

The integration command exercises the real WASM callback chain and a production
browser build, including startup, keyboard input, status rendering, save, and
restore. The long suite repeatedly checks session lifecycle, save restoration,
and raw save transfer before a release.

## Repository Guide

- [prealpha-1 plan](doc/BlissHack/plans/prealpha-1.md)
- [prealpha-2 plan](doc/BlissHack/plans/prealpha-2.md)
- [prealpha-3 plan](doc/BlissHack/plans/prealpha-3.md)
- [prealpha-4 refactoring plan](doc/BlissHack/plans/prealpha-4.md)
- [Upstream modification inventory](doc/BlissHack/upstream-modifications.md)
- [Fatal errors and diagnostic log design](doc/BlissHack/plans/in-prealpha-2/fatal-errors-and-diagnostics.md)
- [Browser end-to-end test design](doc/BlissHack/plans/in-prealpha-2/browser-end-to-end-tests.md)
- [WASM build process](doc/BlissHack/build-process.md)
- [Shim interface reference](doc/BlissHack/shim-interface-reference.md)
- [Key input reference](doc/BlissHack/key-input-reference.md)
- [Chinese Guidebook index](doc/BlissHack/guidebook-index-cn.md)
- [Frontend source](frontend/src)

## Known Interface Limits

The current upstream shim ABI cannot safely return non-empty message history
strings and does not expose `yn_number`. BlissHack preserves safe behavior
instead of guessing unexposed memory or callback semantics. Details are
recorded in the [shim interface reference](doc/BlissHack/shim-interface-reference.md).

## License

BlissHack contains and is derived from NetHack. It is distributed at no charge
under the terms of the
[NetHack General Public License](dat/license), without warranty as described
there. The complete corresponding source used to build the browser executable
is available in this repository.

The original NetHack copyright and license notices are retained. Third-party
frontend dependencies remain subject to their respective licenses.

BlissHack modifications documented in this repository were added in 2026.
Most changes are confined to the browser frontend, tests, documentation, and
deployment configuration. The small number of modifications to NetHack C code
carry file-level modification notices and are documented in the
[shim interface reference](doc/BlissHack/shim-interface-reference.md#6-当前项目对-shim-接口的修改).
