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
 * Which PRD pair groups the pool's metadata can honestly support.
 *
 *   clear       — needs `tier`: pairs across tiers, so the gap is obvious
 *   robustness  — needs `outfitTag`: pairs similar outfits on different people
 *   close       — always available: the default like-for-like comparison
 *
 * A group is omitted rather than faked. Emitting a `robustness` label for a
 * pair built exactly like a `close` pair would put meaningless group metadata
 * into the training set.
 */
export function availableGroups(images: readonly PoolImage[]): PairGroup[] {
  const groups: PairGroup[] = [];
  if (images.some((image) => image.tier !== undefined)) groups.push("clear");
  groups.push("close");
  const tagged = images.filter((image) => image.outfitTag !== undefined);
  const sharedTag = new Set(tagged.map((image) => image.outfitTag)).size < tagged.length;
  if (sharedTag) groups.push("robustness");
  return groups;
}

/**
 * Builds the PRD pair groups the pool can support (see `availableGroups`).
 * Quota is split across whichever groups are constructible.
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

  const groups = availableGroups(images);
  const weights: Record<PairGroup, number> = { clear: 0.2, close: 0.55, robustness: 0.25 };
  const totalWeight = groups.reduce((sum, group) => sum + weights[group], 0);
  const wanted = Object.fromEntries(
    groups.map((group) => [group, Math.round((target * weights[group]) / totalWeight)]),
  ) as Record<PairGroup, number>;

  for (const [split, pool] of bySplit) {
    if (pool.length < 2) continue;
    const share = pool.length / images.length;

    for (const group of groups) {
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
          if (group === "clear") {
            // An obvious quality gap: only meaningful when both tiers are known.
            return a.tier !== undefined && other.tier !== undefined && a.tier !== other.tier;
          }
          if (group === "robustness") {
            // Similar outfit, different person — exposes background/person bias.
            return a.outfitTag !== undefined && a.outfitTag === other.outfitTag;
          }
          // close: like-for-like difficulty, and never a cross-tier gift.
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
