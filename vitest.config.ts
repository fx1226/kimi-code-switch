import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
      "@renderer": resolve("src/renderer/src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // 桥接是纯 Node 侧（http/net/crypto），必须跑在 node 环境而非 jsdom。
    // 本地服务（src/server）同样是纯 Node 侧（http/fs/crypto + window shim）。
    environmentMatchGlobs: [["src/bridge/**", "node"], ["src/server/**", "node"]],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // 覆盖率门禁同时覆盖纯业务逻辑（src/shared）与 Tauri 前端适配层。
      // 行、语句和函数执行率统一守住 80%；分支仍按薄适配器大量平台/error fallback
      // 的实际结构设置 70%，避免为了数字移除必要的防御分支。
      include: ["src/shared/**/*.ts", "src/renderer/src/tauri/**/*.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
