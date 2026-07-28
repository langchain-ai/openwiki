import { defineConfig } from "vitest/config";

/**
 * Vitest configuration.
 *
 * Test discovery is left on Vitest's defaults; this file only configures
 * coverage. `all: true` plus an explicit `include` makes `pnpm coverage` report
 * the entire `src` tree, so files that no test imports yet show up as 0% instead
 * of being silently omitted. Without this, coverage flatters itself by counting
 * only the files a test happens to touch.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "text-summary", "html", "json-summary", "lcov"],
    },
  },
});
