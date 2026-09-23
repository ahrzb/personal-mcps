import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// The build emits exactly two files at fixed names, `dist/app.js` and `dist/app.css`,
// because the Worker serves them by name (web.ts's two asset routes) and a Worker cannot read
// a Vite manifest to discover a hashed one. Revalidation is therefore the asset platform's
// ETag rather than a content hash in the URL, which is safe for the reason web.ts records:
// the hazard is an unversioned URL carrying `immutable`, which nothing here sets.
// `dist/app.css` is the page's only stylesheet: legacy.css reaches it through app.css's
// `@import`, so the dev server needs no route of its own for it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
