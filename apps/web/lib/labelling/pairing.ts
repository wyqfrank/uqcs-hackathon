import type { Pair, PairGroup, PoolImage, Split } from "./types";

/**
 * Deterministic pair construction. Every rater sees the same pair set in the
 * same order, so multiple independent judgements land on the same pair ids and
 * inter-rater agreement is measurable.
 */

/** mulberry32 — small, fast, and reproducible across runs. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Assign each SUBJECT (not image) to a split, so an image and an adjacent frame
 * of the same outfit can never straddle a boundary — PRD requirement.
 */
export function assignSplits(
  images: readonly Omit<PoolImage, "split">[],
  ratios: { train: number; val: number } = { train: 0.7, val: 0.15 },
): PoolImage[] {
  const subjects = [...new Set(images.map((i) => i.subjectId))].sort();
  const bySubject = new Map<string, Split>();
  for (const subject of subjects) {
    // Hash the subject id rather than shuffling, so adding images later does
    // not reshuffle existing subjects across splits.
    const r = makeRng(hashString(subject))();
    const split: Split = r < ratios.train ? "train" : r < ratios.train + ratios.val ? "val" : "test";
    bySubject.set(subject, split);
  }
  return images.map((image) => ({ ...image, split: bySubject.get(image.subjectId)! }));
}

function pairId(a: string, b: string, group: PairGroup): string {
  return `${group}:${[a, b].sort().join("|")}`;
}

export type BuildOptions = {
  seed?: number;
  /** Target number of pairs. The PRD asks for 500–1,000 decisions. */
  target?: number;
  /** Fraction of pairs that also collect reason tags. */
  reasonRate?: number;
  /** Fraction that also collect dimension judgements — PRD says 20–30%. */
  dimensionRate?: number;
};

/**
 * Builds the three PRD pair groups:
 *   clear       — different curator tiers; validates the rater understands the task
 *   close       — same tier; carries the actual preference signal
 *   robustness  — same tier, different subject; exposes background/person bias
 *
 * Pairs never cross a split boundary and never pair an image with itself or
 * with another image of the same subject.
 */
export function buildPairs(images: readonly PoolImage[], options: BuildOptions = {}): Pair[] {
  const { seed = 1, target = 600, reasonRate = 0.35, dimensionRate = 0.25 } = options;
  const rng = makeRng(seed);
  const seen = new Set<string>();
  const pairs: Pair[] = [];

  const bySplit = new Map<Split, PoolImage[]>();
  for (const image of images) {
    const list = bySplit.get(image.split) ?? [];
    list.push(image);
    bySplit.set(image.split, list);
  }

  const wanted: Record<PairGroup, number> = {
    clear: Math.round(target * 0.2),
    close: Math.round(target * 0.55),
    robustness: Math.round(target * 0.25),
  };

  for (const [split, pool] of bySplit) {
    if (pool.length < 2) continue;
    const share = pool.length / images.length;

    for (const group of ["clear", "close", "robustness"] as const) {
      const quota = Math.max(1, Math.round(wanted[group] * share));
      let attempts = 0;
      let made = 0;

      while (made < quota && attempts < quota * 40) {
        attempts += 1;
        const candidates = shuffled(pool, rng);
        const a = candidates[0];
        const b = candidates.find((other) => {
          if (other.id === a.id) return false;
          // Never compare two frames of the same person/outfit/session.
          if (other.subjectId === a.subjectId) return false;
          if (group === "clear") return a.tier !== undefined && other.tier !== undefined && a.tier !== other.tier;
          // close and robustness both want like-for-like difficulty.
          return a.tier === other.tier;
        });
        if (!b) continue;

        const id = pairId(a.id, b.id, group);
        if (seen.has(id)) continue;
        seen.add(id);

        pairs.push({
          id,
          group,
          split,
          leftId: a.id,
          rightId: b.id,
          askReasons: rng() < reasonRate,
          askDimensions: rng() < dimensionRate,
        });
        made += 1;
      }
    }
  }

  return shuffled(pairs, makeRng(seed ^ 0x5f3759df));
}

/**
 * Per-rater left/right mirroring. Deterministic in (pairId, raterId) so a rater
 * reloading mid-session sees the same arrangement, but different raters see the
 * pair from both sides.
 */
export function isMirroredFor(pairId: string, raterId: string): boolean {
  return makeRng(hashString(`${pairId}#${raterId}`))() < 0.5;
}
