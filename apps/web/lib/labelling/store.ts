import { mkdir, readdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { assignSplits } from "./pairing";
import type { Decision, PoolImage } from "./types";

/**
 * Server-side storage for the labelling station. Deliberately flat files:
 * the dataset is small, and JSONL is trivial to hand to a training script.
 */

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export const POOL_DIR = path.join(process.cwd(), "public", "label-pool");
export const DATA_DIR = path.join(process.cwd(), "..", "..", "data", "labelling");
export const DECISIONS_FILE = path.join(DATA_DIR, "decisions.jsonl");

/**
 * Filenames carry their own metadata so curating the pool is a rename, not a
 * spreadsheet:  `<subject>__<tier>__<anything>.jpg`  e.g. `s01__high__front.jpg`
 * Missing parts degrade gracefully — the file still enters the pool.
 */
export function parsePoolFilename(filename: string): { subjectId: string; tier?: PoolImage["tier"] } {
  const stem = filename.replace(/\.[^.]+$/, "");
  const [subject, tier] = stem.split("__");
  const normalised = tier?.toLowerCase();
  return {
    subjectId: subject || stem,
    tier: normalised === "high" || normalised === "mid" || normalised === "low" ? normalised : undefined,
  };
}

export async function readPool(): Promise<PoolImage[]> {
  let entries: string[];
  try {
    entries = await readdir(POOL_DIR);
  } catch {
    return [];
  }

  const bare = entries
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => ({
      id: name.replace(/\.[^.]+$/, ""),
      src: `/label-pool/${encodeURIComponent(name)}`,
      ...parsePoolFilename(name),
    }));

  return assignSplits(bare);
}

export async function readDecisions(): Promise<Decision[]> {
  try {
    const raw = await readFile(DECISIONS_FILE, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Decision);
  } catch {
    return [];
  }
}

export async function appendDecision(decision: Decision): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(DECISIONS_FILE, `${JSON.stringify(decision)}\n`, "utf8");
}
