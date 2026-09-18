---
title: "Architecture Constraints"
readMode: required
priority: high
category: arch
---
# Architecture Constraints

Auto-generated from project structure. Update manually as architecture evolves.

## Module Structure
- Type: single-package (Tauri v2 app — thin Rust shell + frontend business logic)
- Key modules:
  - `src-tauri/src/` — Rust backend, exposes Tauri commands (I/O + system-integration primitives only):
    - `fs_access.rs` — file I/O (read/write/ensure_dir/list_dir/hostname, resolves `~/` paths)
    - `system.rs` — `exec_command`, `http_request` (reqwest), log tail, `write_executable`
    - `usage.rs` — SQLite via `rusqlite` (`usage_query`/`usage_exec`/...)
    - `tray.rs` — dynamic system tray (menu JSON in, `tray://command` events out)
  - `src/renderer/src/` — React SPA (single App.tsx, tab-based navigation, no router)
  - `src/renderer/src/tauri/` — desktop-runtime adapters bridging `window.kimiSwitch` to Rust commands (kimiSwitch.ts, usageDb.ts, cli.ts, terminal.ts, webdav.ts, tray.ts, ...)
  - `src/renderer/src/http/` — browser-runtime adapter (`kimiSwitchHttp.ts` Proxy over `/api/call`, `sseClient.ts`) for the local Node web-server runtime
  - `src/renderer/src/runtime.ts` — `isDesktopRuntime()` selects desktop vs browser adapter at bootstrap
  - `src/server/` — Node local web-server runtime (browser/web-version backend):
    - `main.ts` / `runtime.ts` — process entry + in-process `window` shim (must load first)
    - `http/` — routes (`/api/ping|version|call|events`), auth (bearer/Host/Origin), SSE, static dist/
    - `native/` — Node ports of Rust commands (fs/system/usage/stores) behind a `commandRegistry`
    - `native/tauriShims/` — Node replacements for `@tauri-apps/*` (esbuild alias)
  - `src/shared/` — Pure logic (zero Node/Rust deps): types, configStore, utilities

## Layer Boundaries
- `shared/` → no imports from renderer or Tauri adapters (pure, host-agnostic)
- `src/renderer/src/tauri/` → may import types from `@shared/*`, bridges to Rust via `invoke()` / `listen()`
- `src/renderer/src/http/` → browser-runtime adapter; no Tauri `invoke()`; calls the local server via `POST /api/call` and SSE (`sseClient.ts`)
- `renderer/` → imports from `@shared/*` and `@renderer/*`, accesses backend via `window.kimiSwitch`
- `src-tauri/src/` → Rust I/O and system primitives only; no business logic (that lives in `src/shared`)
- `src/server/` → Node-only runtime; imports `@shared/*` and the renderer adapter chain via the `window` shim (`runtime.ts`); no DOM browser APIs
- `src/server/native/` → Node ports of Rust I/O/system/SQLite primitives; exposes a `commandRegistry`/`invokeCommand`; no business logic
- `src/server/native/tauriShims/` → Node stand-ins for `@tauri-apps/*`, swapped in by esbuild alias so renderer adapters run unchanged in the Node process

## Dependency Rules
- Renderer NEVER calls Rust commands directly — always via the `window.kimiSwitch` adapter surface
- Two mutually exclusive `window.kimiSwitch` adapters share one API surface: `tauri/kimiSwitch.ts` (desktop) and `http/kimiSwitchHttp.ts` (browser); `runtime.ts` `isDesktopRuntime()` picks at bootstrap in `main.tsx`
- The server runtime executes the same renderer/shared business chain in-process: `window` shim + `tauriShims` + `commandRegistry` keep the adapter code unchanged across desktop/web
- All server endpoints except `/api/ping`, `/api/version`, and static assets are guarded by `guardRequest` in `http/auth.ts` (random bearer token + `127.0.0.1`/`localhost` Host whitelist + same-origin Origin check); native writes/deletes always pass `authorizeMutation`
- Desktop runtime never uses `/api/call`; the browser runtime never calls Tauri `invoke`
- `window.kimiSwitch` is injected at runtime (gated on `__TAURI_INTERNALS__` / `/api/ping` probe); adapters call `invoke()` or `/api/call` for commands and `listen()`/SSE for backend events
- Shared layer has zero side effects — all functions are pure
- FileAccess interface abstracts filesystem (Tauri adapter in prod, in-memory for testing)

## Technology Constraints
- Runtime: Tauri v2 + Rust + system WebView; plus a local Node 22 web-server runtime (`node:sqlite`, esbuild bundle → `dist-server/server.mjs`, `@yao-pkg/pkg` sidecar binaries)
- Frontend module system: ESM (Vite)
- Strict mode: TypeScript strict (noEmit check in build)
- Backend storage: SQLite via Rust `rusqlite` (desktop) and `node:sqlite` `DatabaseSync` singleton (server, shared by usage/stores)
- Build: Tauri CLI + Vite (vite.config.ts → dist/), esbuild (`build:server`), pkg (`build:server:sidecar`)

## Entries

