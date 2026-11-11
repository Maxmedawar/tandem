import { configDefaults, defineConfig } from "vitest/config";

// An inline (empty) PostCSS config stops vite/vitest from walking UP past the
// repo for a postcss.config.js — a stray one in a parent directory (e.g.
// $HOME) would otherwise break every test run with unrelated plugin errors.
// This repo has no CSS to process.
// hub/ is its own package with its own dependencies: its suite runs from hub/.
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: { exclude: [...configDefaults.exclude, "hub/**"], setupFiles: ["test/setup-home.ts"] },
});
