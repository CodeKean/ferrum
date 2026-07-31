import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** The repo root — one level up from web/. */
const repo = resolve(here, "..");

export default defineConfig({
  root: here,
  plugins: [react()],
  /**
   * `@shared` reaches the engine's import-free modules.
   *
   * A handful of rules are the same question on both sides — what a failure class means, whether a
   * column can be typed into — and they were being answered twice, by hand, in two files that had
   * no way to notice they disagreed. (`web/src/api.ts` and `explainCell.ts` each still keep their own
   * copy of the ColumnKind union, which is the same problem waiting.)
   *
   * Only modules that import NOTHING may be reached this way. One import of anything touching
   * `node:sqlite` breaks the production bundle rather than the typecheck, so each shared module has a
   * test asserting it has no imports at all.
   */
  resolve: {
    alias: { "@shared": resolve(repo, "src") },
  },
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 4318,
    // Scoped to the repo, not widened to the filesystem: the dev server may read one directory up
    // for @shared and nothing beyond it.
    fs: { allow: [repo] },
    // The engine holds the DB, the credentials and the agent runner; the dev server only serves the
    // client. Everything data-shaped is proxied to it so dev and production behave identically.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
        // SSE must not be buffered by the proxy or live cell updates arrive in clumps.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
});
