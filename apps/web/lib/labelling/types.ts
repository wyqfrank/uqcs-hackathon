/**
 * Types for the A/B outfit-labelling station.
 * Mirrors docs/PRD.md § "Target-audience pair comparisons".
 */

/** Pair construction groups from the PRD. */
export type PairGroup = "clear" | "close" | "robustness";

/** Dataset split. Assigned per person/outfit so no image crosses a boundary. */
export type Split = "train" | "val" | "test";

export type PoolImage = {
  id: string;
  src: string;
  /** Grouping key: images of the same person/outfit/session must not cross splits. */
  subjectId: string;
  split: Split;
  /** Optional curator hint used only to build "clear" pairs. Never shown to raters. */
  tier?: "high" | "mid" | "low";
  /**
   * Optional curator label for outfit style/type (e.g. "streetwear-casual").
   * Robustness pairs need this: they compare *similar outfits* worn by
   * different people under different conditions, which cannot be inferred
   * from the files alone.
   */
  outfitTag?: string;
};

export type Pair = {
  id: string;
  group: PairGroup;
  split: Split;
  /** Stable pool ids. Presentation order is randomised separately, per rater. */
  leftId: string;
  rightId: string;
  /** True when this pair should also collect reason tags. */
  askReasons: boolean;
  /** True when this pair should also collect per-dimension judgements. */
  askDimensions: boolean;
};

export type Verdict = "a" | "b" | "close" | "unjudgeable";

export const REASON_TAGS = [
  "Individual pieces",
  "Outfit coordination",
  "Fit and proportion",
  "Colour",
  "Layering",
  "Other",
] as const;
export type ReasonTag = (typeof REASON_TAGS)[number];

export const DIMENSIONS = [
  "Component quality",
  "Whole-outfit coordination",
  "Garment fit and proportion",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export type DimensionAnswer = "a" | "b" | "equal" | "unjudgeable";

export type Rater = {
  id: string;
  cohort: string;
  /** Self-reported fashion engagement, 1 (low) to 5 (high). */
  engagement: number;
};

export type Decision = {
  pairId: string;
  raterId: string;
  raterCohort: string;
  raterEngagement: number;
  /** Which pool image the rater actually saw on the left. */
  shownLeftId: string;
  shownRightId: string;
  /** Verdict in terms of the SHOWN sides. */
  shownVerdict: Verdict;
  /** Verdict normalised back to the canonical pair order. */
  verdict: Verdict;
  /** PRD label interpretation: a=1.0, b=0.0, close=0.5, unjudgeable=null. */
  target: number | null;
  group: PairGroup;
  split: Split;
  reasons: ReasonTag[];
  dimensions: Partial<Record<Dimension, DimensionAnswer>>;
  /** Milliseconds from pair shown to verdict. Used to spot rushed labels. */
  latencyMs: number;
  decidedAt: string;
};

/** PRD label interpretation. `Cannot judge` is excluded from preference training. */
export function verdictToTarget(verdict: Verdict): number | null {
  if (verdict === "a") return 1;
  if (verdict === "b") return 0;
  if (verdict === "close") return 0.5;
  return null;
}

/** Flip a verdict when the rater saw the pair mirrored. */
export function unmirrorVerdict(verdict: Verdict, wasMirrored: boolean): Verdict {
  if (!wasMirrored) return verdict;
  if (verdict === "a") return "b";
  if (verdict === "b") return "a";
  return verdict;
}
