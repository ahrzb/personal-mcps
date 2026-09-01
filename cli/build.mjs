// cli/build.mjs — cli/*.ts → cli/dist/*.mjs for `npm publish` (prepublishOnly).
// The published bin must be JavaScript: node refuses to type-strip anything under
// node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, unconditional), so
// the .mts sources the repo runs directly cannot ship as the bin. The stripper is
// node's own (module.stripTypeScriptTypes) — no install, no toolchain; dist/ is
// gitignored and rebuilt on every publish.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every CLI source, dist-relative output path → cli-relative source path. */
const FILES = {
  "pmcp.mjs": "pmcp.mts",
  "src/main.mjs": "src/main.ts",
  "src/commands.mjs": "src/commands.ts",
  "src/plan.mjs": "src/plan.ts",
  "src/config.mjs": "src/config.ts",
  "src/render.mjs": "src/render.ts",
  "src/errors.mjs": "src/errors.ts",
};

for (const [dest, source] of Object.entries(FILES)) {
  const stripped = stripTypeScriptTypes(readFileSync(join(HERE, source), "utf8"));
  // House imports carry explicit .ts/.mts extensions; only the specifier inside the
  // quotes changes, so line numbers keep matching the source.
  const path = join(HERE, "dist", dest);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stripped.replace(/(from\s+")([^"]+)\.m?ts(")/g, "$1$2.mjs$3"));
}
process.stdout.write(`built cli/dist (${Object.keys(FILES).length} files)\n`);
