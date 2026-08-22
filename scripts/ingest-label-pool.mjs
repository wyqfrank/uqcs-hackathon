#!/usr/bin/env node
/**
 * Ingest a flat folder of outfit photos into the labelling pool.
 *
 *   node scripts/ingest-label-pool.mjs <source-dir> [--dry-run] [--clear]
 *
 * A flat dump carries no grouping information, so every photo becomes its own
 * subject. That is correct when each photo shows a different person wearing a
 * different outfit. If several photos DO show the same person or outfit, tell
 * the script by prefixing those filenames with a shared token and a dash, e.g.
 * `alice-01.jpg`, `alice-02.jpg` — see --group-by-prefix.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const POOL_DIR = path.join(REPO_ROOT, "apps", "web", "public", "label-pool");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const sourceDir = args.find((a) => !a.startsWith("--"));

/**
 * Fingerprint of the installed pool. Pair ids are derived from filenames, so
 * two raters only produce comparable labels if this matches. Checking takes a
 * second; discovering a mismatch after labelling costs an hour of work.
 */
async function fingerprint() {
  let entries;
  try {
    entries = await readdir(POOL_DIR);
  } catch {
    console.error(`No pool at ${POOL_DIR}. Run the ingest first.`);
    process.exit(1);
  }
  const ids = entries
    .filter((n) => IMAGE_EXTENSIONS.has(path.extname(n).toLowerCase()))
    .map((n) => n.replace(/\.[^.]+$/, ""))
    .sort();
  const hash = createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16);
  console.log(`pool fingerprint: ${hash}`);
  console.log(`images: ${ids.length}`);
  console.log("");
  console.log("Every rater must see the same fingerprint. If yours differs, your");
  console.log("labels cannot be aggregated with the others' — re-ingest from the");
  console.log("identical photo set before rating.");
  return hash;
}

if (flags.has("--fingerprint")) {
  await fingerprint();
  process.exit(0);
}

if (!sourceDir) {
  console.error("usage: node scripts/ingest-label-pool.mjs <source-dir> [--dry-run] [--clear] [--group-by-prefix]");
  console.error("       node scripts/ingest-label-pool.mjs --fingerprint");
  process.exit(1);
}

const dryRun = flags.has("--dry-run");
const groupByPrefix = flags.has("--group-by-prefix");

/** Stable, filesystem-safe subject id derived from the original filename. */
function subjectFor(filename) {
  if (groupByPrefix) {
    const prefix = path.basename(filename, path.extname(filename)).split("-")[0];
    if (prefix) return prefix.toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  // Hash rather than a counter, so re-running after adding files keeps existing
  // ids (and therefore existing split assignments and decisions) stable.
  return createHash("sha1").update(filename).digest("hex").slice(0, 10);
}

const source = path.resolve(sourceDir);

/**
 * Walk the source tree. Archives usually extract into a wrapper folder, so a
 * non-recursive scan reports "no images" for a directory that plainly has
 * them. Returns paths relative to `source`.
 */
async function collectImages(dir, prefix = "") {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    // Skip macOS archive cruft and hidden directories.
    if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) found.push(...(await collectImages(path.join(dir, entry.name), rel)));
    else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(rel);
  }
  return found;
}

const found = await collectImages(source);
if (found.length === 0) {
  console.error(`No .jpg/.jpeg/.png/.webp files under ${source}`);
  process.exit(1);
}
// Ids come from the basename only, so the wrapper folder cannot change them.
const relByName = new Map();
for (const rel of found) {
  const base = path.basename(rel);
  if (relByName.has(base)) {
    console.error(`  ! duplicate filename in different folders: ${base} — ids would collide`);
    process.exit(1);
  }
  relByName.set(base, rel);
}
const images = [...relByName.keys()].sort();

if (flags.has("--clear") && !dryRun) {
  await rm(POOL_DIR, { recursive: true, force: true });
}
if (!dryRun) await mkdir(POOL_DIR, { recursive: true });

const subjects = new Set();
let copied = 0;
let skipped = 0;

for (const name of images) {
  const extension = path.extname(name).toLowerCase();
  const subject = subjectFor(name);
  subjects.add(subject);

  // No tier and no outfit tag: a flat dump supports `close` pairs only.
  // The store's parser treats a missing second segment as "no tier".
  const target = `${subject}__${path.basename(name, path.extname(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)}${extension}`;

  const sourcePath = path.join(source, relByName.get(name));
  const info = await stat(sourcePath);
  if (!info.isFile()) { skipped += 1; continue; }

  if (dryRun) console.log(`${name}  ->  ${target}`);
  else await copyFile(sourcePath, path.join(POOL_DIR, target));
  copied += 1;
}

console.log(
  `\n${dryRun ? "[dry run] would copy" : "copied"} ${copied} image${copied === 1 ? "" : "s"}` +
  `${skipped ? `, skipped ${skipped}` : ""} -> apps/web/public/label-pool/`,
);
console.log(`subjects: ${subjects.size}`);
if (subjects.size === copied) {
  console.log("every photo is its own subject — pairs will all be group 'close'.");
}
if (copied < 2) console.log("WARNING: at least two subjects are needed to build any pair.");

if (!dryRun) {
  console.log("");
  await fingerprint();
}
