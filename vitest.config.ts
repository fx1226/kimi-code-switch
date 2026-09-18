import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@shared": resolve("src/shared"), "@renderer": resolve("src/renderer/src") } },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environmentMatchGlobs: [["src/server/**", "node"]],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/shared/**/*.ts", "src/server/**/*.ts", "src/renderer/src/web/**/*.ts", "src/renderer/src/web/**/*.tsx"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.d.ts"],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
