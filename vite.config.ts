import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite 配置：构建 renderer（前端），后端由 src-tauri 的 Rust 提供。
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  plugins: [react()],
  define: {
    global: "globalThis",
  },
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer/src"),
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
  // Tauri 期望固定端口，且失败时不要回退
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // dev 联调：浏览器形态经 Vite 代理访问本地 Node 服务的 /api。
    proxy: {
      "/api": "http://127.0.0.1:8417",
    },
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
