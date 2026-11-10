import { defineConfig } from "vitest/config";

// An inline (empty) PostCSS config stops vite/vitest from walking UP past the
// repo for a postcss.config.js — a stray one in a parent directory (e.g.
// $HOME) would otherwise break every test run with unrelated plugin errors.
// This package has no CSS to process. fileParallelism is off: the files that
// start a local hub with `wrangler dev --local` run one at a time.
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: { fileParallelism: false },
});
