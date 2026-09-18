import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };
export default defineConfig({
  root: resolve(root, "src/renderer"),
  plugins: [react()],
  define: { "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version) },
  resolve: { alias: { "@renderer": resolve(root, "src/renderer/src"), "@shared": resolve(root, "src/shared") } },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    proxy: { "/api": { target: process.env.KIMI_DEV_SERVER_URL ?? "http://127.0.0.1:8417", changeOrigin: true } },
  },
  build: { outDir: resolve(root, "dist"), emptyOutDir: true },
});
