#!/usr/bin/env node
/**
 * Merge rater decision files collected on separate machines.
 *
 *   node scripts/merge-labels.mjs ~/Downloads/decisions.angus.jsonl ~/Downloads/decisions.frank.jsonl
 *   node scripts/merge-labels.mjs ~/Downloads/labels/          # every .jsonl in a folder
 *
 * Copies each file into data/labelling/ (keyed by the rater id inside it, not
 * the filename), then reports whether the merge is actually comparable.
 *
 * The failure this guards against: pair ids are derived from image filenames,
 * so a rater who ingested a different photo set produces ids nobody else has.
 * The merge succeeds, the totals look healthy, and there is nothing to compare.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data", "labelling");

const inputs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");

if (inputs.length === 0) {
  console.error("usage: node scripts/merge-labels.mjs <file-or-dir>... [--dry-run]");
  process.exit(1);
}

function slug(raterId) {
  return (raterId ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 40) || "unknown";
}

async function expand(target) {
  const info = await stat(target).catch(() => null);
  if (!info) { console.error(`  ! not found: ${target}`); return []; }
  if (!info.isDirectory()) return [target];
  const entries = await readdir(target);
  return entries.filter((n) => n.endsWith(".jsonl")).map((n) => path.join(target, n));
}

const files = (await Promise.all(inputs.map(expand))).flat();
if (files.length === 0) { console.error("No .jsonl files found."); process.exit(1); }

// Group incoming rows by the rater id recorded inside them. Filenames lie;
// the rows do not.
const byRater = new Map();
let malformed = 0;
for (const file of files) {
  const raw = await readFile(file, "utf8").catch(() => "");
  let kept = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row.pairId || !row.raterId) { malformed += 1; continue; }
      const key = slug(row.raterId);
      if (!byRater.has(key)) byRater.set(key, new Map());
      // Deduplicate: same rater + same pair keeps the latest decision.
      const existing = byRater.get(key).get(row.pairId);
      if (!existing || row.decidedAt > existing.decidedAt) byRater.get(key).set(row.pairId, row);
      kept += 1;
    } catch { malformed += 1; }
  }
  console.log(`  read ${String(kept).padStart(5)} rows  ${path.basename(file)}`);
}

if (malformed) console.log(`  (skipped ${malformed} malformed line${malformed === 1 ? "" : "s"})`);

// Fold in whatever is already in data/labelling/ so a re-run is safe.
await mkdir(DATA_DIR, { recursive: true });
for (const name of (await readdir(DATA_DIR).catch(() => []))) {
  if (!name.startsWith("decisions.") || !name.endsWith(".jsonl")) continue;
  const raw = await readFile(path.join(DATA_DIR, name), "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const key = slug(row.raterId);
      if (!byRater.has(key)) byRater.set(key, new Map());
      const existing = byRater.get(key).get(row.pairId);
      if (!existing || row.decidedAt > existing.decidedAt) byRater.get(key).set(row.pairId, row);
    } catch { /* ignore */ }
  }
}

console.log("");
for (const [rater, rows] of [...byRater].sort()) {
  const file = path.join(DATA_DIR, `decisions.${rater}.jsonl`);
  const sorted = [...rows.values()].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  if (!dryRun) await writeFile(file, sorted.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.log(`  ${dryRun ? "would write" : "wrote"} ${String(sorted.length).padStart(5)} -> decisions.${rater}.jsonl`);
}

// ---- Is the merge actually comparable? -----------------------------------
const raters = [...byRater.keys()].sort();
const pairsOf = (r) => byRater.get(r);
const allPairs = new Set([...byRater.values()].flatMap((m) => [...m.keys()]));
const seenBy = (pairId) => raters.filter((r) => pairsOf(r).has(pairId)).length;

let shared = 0;
for (const pairId of allPairs) if (seenBy(pairId) === raters.length) shared += 1;

console.log("");
console.log(`raters: ${raters.length}   distinct pairs: ${allPairs.size}   labelled by all: ${shared}`);

let suspect = false;
for (const rater of raters) {
  const own = [...pairsOf(rater).keys()];
  const overlap = own.length ? own.filter((p) => seenBy(p) > 1).length / own.length : 0;
  const flag = raters.length > 1 && overlap < 0.2;
  if (flag) suspect = true;
  console.log(`  ${rater.padEnd(14)} ${String(own.length).padStart(5)} pairs   ${(overlap * 100).toFixed(0).padStart(3)}% shared${flag ? "   <-- POOL MISMATCH" : ""}`);
}

if (suspect) {
  console.log("");
  console.log("WARNING: at least one rater shares almost no pairs with the others.");
  console.log("Pair ids come from image filenames, so this usually means they ingested");
  console.log("a different photo set. Their labels cannot be aggregated with the rest.");
  process.exitCode = 2;
} else if (raters.length > 1 && shared === 0) {
  console.log("");
  console.log("WARNING: no pair was labelled by every rater, so agreement cannot be measured.");
  process.exitCode = 2;
} else if (raters.length > 1) {
  console.log("");
  console.log("Merge looks comparable. For the consensus training set, run the web app and fetch:");
  console.log("  curl 'http://localhost:3000/api/label/export?format=consensus' -o consensus.csv");
}
