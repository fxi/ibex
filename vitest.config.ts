import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // json-summary feeds the README badge (scripts/coverage_badge.ts).
      reporter: ["text-summary", "json-summary"],
    },
  },
});
