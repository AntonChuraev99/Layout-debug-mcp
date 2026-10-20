---
title: "Own dev-only JSX plugin for data-source-loc"
date: 2026-10-20
type: decision
keywords: [data-source-loc, vite, babel, nextjs, jsx, code-inspector, locatorjs, peer-dependency]
---

# Own dev-only JSX plugin for data-source-loc

## Context

React 19 removed `_debugSource`, so the web inspector gets `file:line` only from a `data-source-loc` attribute (`src/inspector/index.ts`). Existing tools solve click-to-open-in-editor instead:

- code-inspector-plugin (2.0.9) ships a client overlay, a local server and IDE launcher (`@code-inspector/core` depends on `ws`, `launch-ide`, `portfinder`, `@vue/compiler-dom`; source: `npm view`, 2026-10-20).
- LocatorJS `@locator/babel-jsx` (0.5.1) pulls three Babel presets, `@babel/traverse` and its own runtime.

Both use their own attribute format around their runtime.

## Decision

- Ship our own small Babel plugin (`src/plugins/`) as two package subpaths: `./babel` (ESM and CJS, for Babel configs: Next, webpack) and `./vite` (`apply: 'serve'`, `enforce: 'pre'`), which runs the same plugin through `@babel/core` with only parser plugins (`jsx`, `typescript`, then `decorators-legacy` or `decorators`). A file it still can't parse is served unchanged with one warning.
- `@babel/core` is an optional peer dependency (`^7.20.0 || ^8.0.0`), loaded lazily by the Vite entry. A missing one fails `vite dev` with the install command.
- Only lowercase `JSXIdentifier` tags get the attribute; fragments, `<Card>`, `<ui.Button>` and namespaced tags don't. It is added first, so an explicit `data-source-loc` (kept as is) or a later spread wins.
- The value is `relative/path.tsx:line` from Vite's `root` / Babel's `root`, with `/` separators. A file on another drive than the root gets its bare file name: never an absolute path in the DOM.
- The Babel plugin is on only when `BABEL_ENV || NODE_ENV` is explicitly `development`. Not `api.env()`: it falls back to `development` when both are unset, as in `webpack --mode production`. Unset means off plus one warning.

## Why this way

- Wrapping a tool built for something else would add its runtime to the page and still need a format adapter.
- Babel is the one parser that handles TSX and JSX the same way in Vite 7 / 8 and Next.js. `@vitejs/plugin-react` 6 no longer brings Babel (Vite 8 uses Oxc), so the Vite entry cannot rely on it (source: plugin-react 6.0.0 release notes).
- Optional peer: `npx layout-debug-mcp` never downloads Babel (npm does not install optional peers).

## Consequences

- Vite users add `@babel/core` as a dev dependency, and each `.jsx` / `.tsx` file gets one extra Babel parse in dev.
- In Next.js a Babel config replaces SWC for the user's files (webpack) or runs next to it (Turbopack, Next.js 16+): slower dev builds.
- Vue, Svelte and SWC-only builds are not covered.
