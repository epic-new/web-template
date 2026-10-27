import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@/db/schema": path.resolve(
        __dirname,
        "app/admin/database/tests/database-schema.ts",
      ),
      "@": path.resolve(__dirname, "./"),
      "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    setupFiles: "./vitest.setup.ts",
    globals: true,
    fileParallelism: false,
    pool: "forks",
    include: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.unit.ts",
      "**/*.integration.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/.worktrees/**",
      "**/dist/**",
      "**/.next/**",
      "**/test-results/**",
    ],
  },
});
