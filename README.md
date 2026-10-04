# Tools

A collection of web-based tools by [nathsou](https://github.com/nathsou). The site is static, with an index at `/` and each tool at its own route.

| Tool | Route | Description |
| --- | --- | --- |
| [Crypte](crypte/README.md) | `/crypte/` | A local Cryptomator vault manager with vault creation, file management, media previews/conversion jobs, text editing, and passkey unlock. |

## Development

Node and Bun are pinned in `mise.toml`; no other toolchain is required.

```sh
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise run dev
```

Open **http://localhost:5173/** for the tools index or **http://localhost:5173/crypte/** for Crypte.

```sh
mise run check
mise run test
mise run build
mise run preview
```

The production preview is **http://localhost:4173/**. Build output is in `dist/`.

For browser regression tests, install Chromium through the mise-managed Playwright CLI, then run the suite:

```sh
mise exec -- bunx playwright install chromium
mise run e2e
```

## Static hosting

Serve the contents of `dist/` over HTTPS. No backend is needed. Relative asset URLs support hosting at a domain root or a project subdirectory, such as `/tools/` on GitHub Pages. Preserve the `crypte/` directory and serve its `index.html` when visiting `/crypte/`; do not rewrite all requests to the root index. GitHub Pages must serve the **built output**, not the TypeScript source files.

Crypte's manifest, offline cache, media endpoints, and service worker live within its route. Other tools do not inherit its worker. A small root worker retires the former root-scoped Crypte cache when upgrading an existing installation. Vault contents and passwords are not uploaded or stored in the offline cache. All code hosted on this origin should be trusted: browser storage and file permissions belong to the origin.

The included workflow checks types, runs unit tests, and builds the site on pushes to `main` and pull requests. Successful builds on `main` deploy `dist/` to GitHub Pages. Pull requests only run checks. The workflow can also be run manually.

Published site: [Tools](https://nathsou.github.io/tools/) · [Crypte](https://nathsou.github.io/tools/crypte/).

## Layout

- `index.html` and `src/catalog.css`: tools index, with no JavaScript dependency.
- `crypte/index.html`: Crypte entry point; `crypte/README.md`: app documentation.
- `src/App.svelte`, `src/components/`, and `src/lib/`: Crypte UI and vault implementation.
- `public/crypte/`: Crypte icon and install manifest.
- `vite.config.ts`: multi-page build and scoped offline asset manifest.
- `tests/` and `scripts/`: synthetic fixtures, crypto reference checks, browser tests and inspection scripts.

To add a tool, give it a directory with an `index.html`, add that entry to Vite's build inputs, and add a card to the index. Scope any new service worker to that tool's route.

See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for project and third-party licensing.
