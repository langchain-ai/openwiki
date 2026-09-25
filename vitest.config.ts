import { configDefaults, defineConfig } from "vitest/config";

/**
 * Vitest configuration.
 *
 * Test discovery keeps Vitest's defaults and adds one exclusion: a KEB
 * benchmark's reconstructed source tree (`evals/keb/benchmarks/*\/repo/`, rebuilt
 * from a committed bundle when a benchmark loads) carries the upstream project's
 * own `*.test.ts` files. Those belong to the fixture under test, not to this
 * repository, and must never be collected and run as this project's tests, so a
 * benchmark whose `repo/` happens to be present on disk (a prior load, a local
 * run) cannot pollute the suite. Coverage config is otherwise the only thing set
 * here: `all: true` plus an explicit `include` makes `pnpm coverage` report the
 * entire `src` tree, so files that no test imports yet show up as 0% instead of
 * being silently omitted. Without this, coverage flatters itself by counting only
 * the files a test happens to touch.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/benchmarks/*/repo/**"],
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      // `types.ts` modules are pure `interface`/`type` declarations, and
      // `telemetry/index.ts` is a pure re-export barrel; both emit no runtime
      // JavaScript of their own, so v8 reports them as 0-of-0 statements and drags
      // the aggregate down for code that cannot be executed. Exclude them (and
      // .d.ts) so the denominator reflects only files with real, coverable behavior.
      //
      // `visualize/client.ts` is browser-only render glue (canvas, the ForceGraph
      // CDN global, EventSource) that only runs in a real DOM; its pure logic is
      // extracted into `visualize/client-lib.ts` (fully covered), so new logic
      // belongs there, not here. Excluded so the aggregate is not dragged by code
      // a Node unit test can never execute.
      //
      // `setup/credentials/use-init-setup.ts` is the setup wizard's Ink state
      // machine: a stateful `useInput` keyboard flow that ink-testing-library
      // cannot exercise cleanly. Its extractable logic lives in tested modules
      // (`steps.ts`, `format.ts`, `persistence.ts`) and its rendering in
      // `view.tsx` (render-tested); what remains here is the wiring those cannot
      // cover. Excluded so the aggregate is not dragged by code a Node unit test
      // cannot drive.
      exclude: [
        "src/**/*.d.ts",
        "src/**/types.ts",
        "src/telemetry/index.ts",
        "src/visualize/client.ts",
        "src/setup/credentials/use-init-setup.ts",
      ],
      reporter: ["text", "text-summary", "html", "json-summary", "lcov"],
    },
  },
});
