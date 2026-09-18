import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build, context } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packaging = process.argv.includes("--package");
const outfile = join(root, packaging ? "dist-server/server.cjs" : "dist-server/server.mjs");
const options = {
  entryPoints: [join(root, "src/server/main.ts")],
  bundle: true,
  metafile: true,
  platform: "node",
  format: packaging ? "cjs" : "esm",
  target: "node22",
  outfile,
  alias: { "@shared": resolve(root, "src/shared") },
  define: { SERVER_VERSION: JSON.stringify(pkg.version), ...(packaging ? { "import.meta.url": "__SERVER_MODULE_URL__" } : {}) },
  banner: {
    js: packaging
      ? '#!/usr/bin/env node\nconst __SERVER_MODULE_URL__ = require("node:url").pathToFileURL(__filename).href;'
      : '#!/usr/bin/env node\nimport { createRequire as __makeRequire } from "node:module";\nglobalThis.require ??= __makeRequire(import.meta.url);',
  },
  logLevel: "info",
};
if (process.argv.includes("--watch")) {
  const builder = await context(options);
  await builder.rebuild();
  chmodSync(outfile, 0o755);
  await builder.watch();
  console.log("Server build watch ready.");
} else {
  const result = await build(options);
  const included = Object.values(result.metafile.outputs).flatMap(output => Object.entries(output.inputs)
    .filter(([, contribution]) => contribution.bytesInOutput > 0)
    .map(([path, contribution]) => ({ path, bytes: contribution.bytesInOutput })));
  const forbidden = /(?:src\/bridge\/|renderer\/src\/tauri\/|native\/tauriShims\/|@tauri-apps\/|services\/(?:backup|fileAccess|fileSnapshots|configHistory)\.ts$|shared\/(?:chatgptBridge|usageStore|pricing|costEstimate)\.ts$)/;
  const violations = included.filter(({ path }) => forbidden.test(path.replaceAll("\\", "/")));
  const stem = packaging ? "server-package" : "server";
  writeFileSync(join(root, `dist-server/${stem}.metafile.json`), `${JSON.stringify(result.metafile, null, 2)}\n`);
  writeFileSync(join(root, `dist-server/${stem}.dependencies.json`), `${JSON.stringify({ forbiddenRuntimeModules: violations, included: included.filter(({ path }) => path.startsWith("src/")) }, null, 2)}\n`);
  if (violations.length) throw new Error(`Retired runtime modules remain in the release: ${violations.map(entry => entry.path).join(", ")}`);
  chmodSync(outfile, 0o755);
}
