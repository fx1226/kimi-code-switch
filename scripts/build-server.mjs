// 构建本地服务单文件包：src/server/main.ts → dist-server/server.mjs。
// esbuild alias 把 renderer 适配层（kimiSwitch 链）引用的 @tauri-apps/* 模块
// 替换为 src/server/native/tauriShims/ 下的 Node shim；
// define 注入 SERVER_VERSION（取 package.json version）。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const shim = (name) => resolve(root, "src/server/native/tauriShims", name);

await build({
  entryPoints: [join(root, "src/server/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(root, "dist-server/server.mjs"),
  alias: {
    "@tauri-apps/api/core": shim("core.ts"),
    "@tauri-apps/api/event": shim("event.ts"),
    "@tauri-apps/api/app": shim("app.ts"),
    "@tauri-apps/api/window": shim("window.ts"),
    "@tauri-apps/plugin-dialog": shim("plugin-dialog.ts"),
    "@tauri-apps/plugin-opener": shim("plugin-opener.ts"),
    "@tauri-apps/plugin-process": shim("plugin-process.ts"),
    "@shared": resolve(root, "src/shared"),
  },
  define: {
    SERVER_VERSION: JSON.stringify(pkg.version),
  },
  // ESM 产物里的 CJS 依赖（yaml 等）会动态 require node 内置模块，
  // 注入 createRequire 让运行时 require 可用。
  banner: {
    js: "import { createRequire } from \"node:module\";\nconst require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});
