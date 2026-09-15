// 构建桥接 sidecar（自包含二进制）并命名成 Tauri externalBin 约定。
// 用法：node scripts/build-bridge-sidecar.mjs <targetTriple> <pkgTarget>
//   例：aarch64-apple-darwin node22-darwin-arm64
//       x86_64-apple-darwin node22-darwin-x64
//       x86_64-pc-windows-msvc node22-win-x64
// 产物：src-tauri/binaries/bridge-<targetTriple>[.exe]
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const targetTriple = process.argv[2];
const pkgTarget = process.argv[3];

if (!targetTriple || !pkgTarget) {
  console.error("usage: node scripts/build-bridge-sidecar.mjs <targetTriple> <pkgTarget>");
  process.exit(2);
}

const isWindows = targetTriple.includes("windows");
const binariesDir = join(root, "src-tauri", "binaries");
const outputBase = join(binariesDir, "bridge");
const finalName = `${outputBase}-${targetTriple}${isWindows ? ".exe" : ""}`;

mkdirSync(binariesDir, { recursive: true });
rmSync(finalName, { force: true });
rmSync(outputBase, { force: true });
if (isWindows) rmSync(`${outputBase}.exe`, { force: true });

// 1) esbuild 打包单文件
execSync("npx esbuild src/bridge/src/main.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist-bridge/bridge.mjs", {
  cwd: root,
  stdio: "inherit",
});

// 2) pkg 编译为自包含二进制
execSync(`npx pkg dist-bridge/bridge.mjs --targets ${pkgTarget} --output ${outputBase}`, {
  cwd: root,
  stdio: "inherit",
});

// 3) 重命名成 target 后缀
const produced = isWindows ? `${outputBase}.exe` : outputBase;
if (!existsSync(produced)) {
  throw new Error(`pkg did not produce ${produced}`);
}
renameSync(produced, finalName);
console.log(`bridge sidecar ready: ${finalName} (${(statSync(finalName).size / 1024 / 1024).toFixed(1)} MB)`);
