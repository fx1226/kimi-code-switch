import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderPackageReadme } from "./package-readme.mjs";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const [target = "aarch64-apple-darwin", pkgTarget = "node22-darwin-arm64"] = process.argv.slice(2);
if (target !== "aarch64-apple-darwin" || pkgTarget !== "node22-darwin-arm64") {
  throw new Error("This release supports macOS arm64 only.");
}
if (!existsSync(join(root, "dist/index.html")) || !existsSync(join(root, "dist-server/server.mjs"))) {
  throw new Error("Build web and server outputs before packaging.");
}
// pkg 6.22 rewrites ESM .mjs filenames but can retain the old entry path.
// Bundle the same source as CJS for packaging so the snapshot entry is unambiguous.
execFileSync(process.execPath, ["scripts/build-server.mjs", "--package"], { cwd: root, stdio: "inherit" });
const releaseDir = join(root, "dist-release");
const executable = join(releaseDir, "kimi-code-switch");
mkdirSync(releaseDir, { recursive: true });
rmSync(executable, { force: true });
execFileSync(process.execPath, [
  join(root, "node_modules/@yao-pkg/pkg/lib-es5/bin.js"),
  "dist-server/server.cjs", "--config", "package.json", "--fallback-to-source",
  "--targets", pkgTarget, "--output", executable,
], { cwd: root, stdio: "inherit" });
if (!existsSync(executable)) throw new Error("Packaging did not produce an executable.");
// Stage only the self-contained executable and notices. No external Node or dist directory.
const stem = `kimi-code-switch-${pkg.version}-macos-arm64`;
const stage = join(releaseDir, stem);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
writeFileSync(join(stage, "README.md"), renderPackageReadme(pkg.version));
copyFileSync(executable, join(stage, "kimi-code-switch"));
const archive = join(releaseDir, `${stem}.tar.gz`);
execFileSync("tar", ["-czf", archive, "-C", releaseDir, stem], { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(`${archive}.sha256`, `${checksum}  ${stem}.tar.gz\n`);
console.log(`Release ready: ${archive} (${(statSync(archive).size / 1024 / 1024).toFixed(1)} MiB)`);
