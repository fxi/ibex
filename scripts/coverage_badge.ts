/**
 * Turn vitest's coverage summary into a shields.io endpoint badge.
 *
 *   node --import tsx scripts/coverage_badge.ts [coverage/coverage-summary.json] [out.json]
 *
 * CI writes it beside the deployed app, at /ibex/badges/coverage.json, which the README
 * badge reads; no third-party coverage service holds a token for this repository.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [from = "coverage/coverage-summary.json", to = "badges/coverage.json"] =
  process.argv.slice(2);
const summary = JSON.parse(readFileSync(from, "utf8")) as {
  total: { lines: { pct: number } };
};
const pct = summary.total.lines.pct;
const color = pct >= 80 ? "brightgreen" : pct >= 60 ? "yellowgreen" : pct >= 40 ? "yellow" : "orange";
mkdirSync(dirname(to), { recursive: true });
writeFileSync(
  to,
  JSON.stringify({ schemaVersion: 1, label: "coverage", message: `${pct.toFixed(0)}%`, color }),
);
console.log(`coverage ${pct}% → ${to}`);
