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
      // `types.ts` modules are pure `interface`/`type` declarations that emit no
      // runtime JavaScript, so v8 reports them as 0-of-0 statements and drags the
      // aggregate down for code that cannot be executed. Exclude them (and .d.ts)
      // so the denominator reflects only files with real, coverable behavior.
      exclude: ["src/**/*.d.ts", "src/**/types.ts"],
      reporter: ["text", "text-summary", "html", "json-summary", "lcov"],
    },
  },
});
