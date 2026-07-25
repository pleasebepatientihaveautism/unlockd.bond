import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70
      }
    }
  }
});
