import { rmSync } from "node:fs";
import { resolve } from "node:path";
for (const name of ["dist", "dist-server", "dist-release", "coverage"]) {
  rmSync(resolve(import.meta.dirname, "..", name), { recursive: true, force: true });
}
