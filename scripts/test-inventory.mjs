// test-inventory.mjs — regenerate test-inventory.json, the suite's case ledger.
//
// The orchestration plan's standard gate diffs this file: a case may only ever
// move todo → passed; a deleted or reworded case shows up as a removed key.
// Committed at each gate, so `git diff test-inventory.json` IS the audit trail.
// Python cases are pytest's to track — this ledger covers the vitest projects.
import { execSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const tmp = ".vitest-report.json";
try {
  // npx, not bare pnpm: proto's shim refuses to run until its pinned version is installed.
  execSync(`npx pnpm exec vitest run --reporter=json --outputFile=${tmp}`, { stdio: ["ignore", "pipe", "pipe"] });
} catch {
  // Failing tests exit nonzero but still write the report; the gate reads states, not exit codes.
}
const report = JSON.parse(readFileSync(tmp, "utf8"));
rmSync(tmp);

const inventory = {};
for (const file of report.testResults) {
  const rel = path.relative(process.cwd(), file.name).replaceAll("\\", "/");
  const cases = {};
  for (const c of file.assertionResults) cases[c.fullName] = c.status;
  inventory[rel] = Object.fromEntries(Object.entries(cases).sort(([a], [b]) => a.localeCompare(b)));
}
const sorted = Object.fromEntries(Object.entries(inventory).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync("test-inventory.json", JSON.stringify(sorted, null, 2) + "\n");

const counts = {};
for (const cases of Object.values(sorted)) for (const s of Object.values(cases)) counts[s] = (counts[s] ?? 0) + 1;
console.log(`${Object.keys(sorted).length} files ·`, Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(" · "));
