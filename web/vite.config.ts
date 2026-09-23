import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * `/styles.css` in the dev server, read from the shared sheet the Worker serves. The gallery's
 * whole purpose is comparing this rendering against the committed baselines, so it must read
 * the SAME bytes — a copy under `web/public` would be a second stylesheet that drifts, and a
 * drifted baseline comparison proves nothing. Production never reaches this: there the Worker
 * serves `/styles.css` from the same file as a TEXT module.
 */
function sharedStylesheet(): Plugin {
  const source = fileURLToPath(new URL("../server/src/pages/styles.css", import.meta.url));
  return {
    name: "pmcp-shared-stylesheet",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/styles.css", async (_req, res) => {
        res.setHeader("Content-Type", "text/css; charset=utf-8");
        res.end(await readFile(source));
      });
    },
  };
}

// The build emits exactly two files at fixed names, `dist/app.js` and `dist/app.css`,
// because the Worker serves them by name (web.ts's two asset routes) and a Worker cannot read
// a Vite manifest to discover a hashed one. Revalidation is therefore the asset platform's
// ETag rather than a content hash in the URL — the same trade the shell's /styles.css already
// makes, and safe for the reason web.ts records: the hazard is an unversioned URL carrying
// `immutable`, which nothing here sets.
export default defineConfig({
  plugins: [react(), tailwindcss(), sharedStylesheet()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        assetFileNames: "app[extname]",
        inlineDynamicImports: true,
      },
    },
  },
});
