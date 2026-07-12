import js from "@eslint/js";
import tseslint from "typescript-eslint";

const TS_FILES = ["src/**/*.{ts,tsx}", "test/**/*.{ts,tsx}"];

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "*.tgz",
      "pnpm-lock.yaml",
    ],
  },
  js.configs.recommended,
  // Type-checked linting for the TypeScript sources and tests.
  {
    extends: [...tseslint.configs.recommendedTypeChecked],
    files: TS_FILES,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Non-TypeScript files (e.g. this config) can't use type-aware rules.
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // CommonJS scripts (e.g. the install-time environment check) run directly
  // under Node, so they need Node globals and CommonJS module semantics.
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        __dirname: "readonly",
        __filename: "readonly",
        console: "readonly",
        module: "writable",
        process: "readonly",
        require: "readonly",
      },
    },
  },
);
