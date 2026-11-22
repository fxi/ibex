import { defineConfig } from "vitest/config";
// Coverage instrumentation slows the routing suites about twofold (tests/detour.test.ts
// took 6.4 s on CI against the 5 s default), so only that run gets the longer limit.
const coverage = process.argv.includes("--coverage");
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: coverage ? 30_000 : 5_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // json-summary feeds the README badge (scripts/coverage_badge.ts).
      reporter: ["text-summary", "json-summary"],
    },
  },
});
