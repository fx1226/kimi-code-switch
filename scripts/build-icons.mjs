import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const source = join(root, "resources/icon.svg");
if (!readFileSync(source, "utf8").includes("<svg")) throw new Error("resources/icon.svg is not an SVG document");
// Preserve the user-authored vector source; browser rendering needs no native raster toolchain.
const publicDir = join(root, "src/renderer/public");
mkdirSync(publicDir, { recursive: true });
copyFileSync(source, join(publicDir, "favicon.svg"));
console.log("Web favicon generated from resources/icon.svg.");
