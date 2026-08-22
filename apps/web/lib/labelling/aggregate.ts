import { DIMENSIONS, type Decision, type Dimension, type DimensionAnswer, type Verdict } from "./types";

/**
 * Combines independent passes from several raters into per-pair consensus.
 *
 * Each rater labels the full set alone; agreement is measured afterwards. The
 * PRD asks for exactly this so inter-rater agreement — and therefore the
 * realistic model ceiling — can be measured.
 */

export type PairConsensus = {
  pairId: string;
  group: Decision["group"];
  split: Decision["split"];
  raters: string[];
  verdicts: Verdict[];
  /** Verdicts that carry a training target (excludes `Cannot judge`). */
  usableCount: number;
  /**
   * Soft training label: mean of the usable targets. Disagreement lands
   * between 0 and 1 rather than being forced to a hard winner.
   */
  meanTarget: number | null;
  /** Share of raters who gave the modal verdict. 1 = unanimous. */
  agreement: number;
  /** True when raters split on who won (excluding close/unjudgeable). */
  contested: boolean;
  dimensions: Partial<Record<Dimension, { answers: DimensionAnswer[]; agreement: number }>>;
};

function modalShare<T>(values: readonly T[]): number {
  if (values.length === 0) return 0;
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Math.max(...counts.values()) / values.length;
}

export function aggregateByPair(decisions: readonly Decision[]): PairConsensus[] {
  const byPair = new Map<string, Decision[]>();
  for (const decision of decisions) {
    const list = byPair.get(decision.pairId) ?? [];
    list.push(decision);
    byPair.set(decision.pairId, list);
  }

  return [...byPair.entries()]
    .map(([pairId, rows]) => {
      // One vote per rater: a rater who somehow labelled twice counts once.
      const latestByRater = new Map<string, Decision>();
      for (const row of rows) {
        const existing = latestByRater.get(row.raterId);
        if (!existing || row.decidedAt > existing.decidedAt) latestByRater.set(row.raterId, row);
      }
      const votes = [...latestByRater.values()];
      const usable = votes.filter((v) => v.target !== null);

      const dimensions: PairConsensus["dimensions"] = {};
      for (const dimension of DIMENSIONS) {
        const answers = votes
          .map((v) => v.dimensions[dimension])
          .filter((a): a is DimensionAnswer => a !== undefined);
        if (answers.length > 0) dimensions[dimension] = { answers, agreement: modalShare(answers) };
      }

      const winners = usable.filter((v) => v.verdict === "a" || v.verdict === "b").map((v) => v.verdict);

      return {
        pairId,
        group: votes[0].group,
        split: votes[0].split,
        raters: votes.map((v) => v.raterId),
        verdicts: votes.map((v) => v.verdict),
        usableCount: usable.length,
        meanTarget: usable.length
          ? usable.reduce((sum, v) => sum + (v.target as number), 0) / usable.length
          : null,
        agreement: modalShare(votes.map((v) => v.verdict)),
        contested: new Set(winners).size > 1,
        dimensions,
      };
    })
    .sort((a, b) => a.pairId.localeCompare(b.pairId));
}

export type AggregateSummary = {
  raters: string[];
  totalDecisions: number;
  pairsLabelled: number;
  pairsWithMultipleRaters: number;
  /** Mean modal share across multi-rater pairs. 1 = raters never disagreed. */
  meanAgreement: number | null;
  contestedPairs: number;
  perRater: Record<string, number>;
};

export function summarise(decisions: readonly Decision[], consensus: readonly PairConsensus[]): AggregateSummary {
  const multi = consensus.filter((c) => c.raters.length > 1);
  const perRater: Record<string, number> = {};
  for (const decision of decisions) perRater[decision.raterId] = (perRater[decision.raterId] ?? 0) + 1;

  return {
    raters: Object.keys(perRater).sort(),
    totalDecisions: decisions.length,
    pairsLabelled: consensus.length,
    pairsWithMultipleRaters: multi.length,
    meanAgreement: multi.length ? multi.reduce((sum, c) => sum + c.agreement, 0) / multi.length : null,
    contestedPairs: consensus.filter((c) => c.contested).length,
    perRater,
  };
}

/**
 * Health check for a merge of independently collected rater files.
 *
 * Raters only produce comparable data if they saw the *same pairs*. Pair ids
 * are derived from image filenames, so a rater who ingested a different photo
 * set silently produces ids nobody else has — and the merge looks fine while
 * containing nothing to compare. This surfaces that.
 */
export type MergeReport = {
  raters: string[];
  /** Pair ids seen by every rater. Only these can be compared. */
  sharedPairs: number;
  /** Pair ids seen by at least one rater but not all. */
  partialPairs: number;
  /** Ids unique to a single rater, keyed by rater. A large count means pool divergence. */
  exclusiveByRater: Record<string, number>;
  /** Share of one rater's pairs that any other rater also labelled. */
  overlapByRater: Record<string, number>;
  /** True when at least one rater shares almost nothing with the others. */
  poolMismatchSuspected: boolean;
  warnings: string[];
};

export function reportMerge(decisions: readonly Decision[]): MergeReport {
  const byRater = new Map<string, Set<string>>();
  for (const decision of decisions) {
    const set = byRater.get(decision.raterId) ?? new Set<string>();
    set.add(decision.pairId);
    byRater.set(decision.raterId, set);
  }

  const raters = [...byRater.keys()].sort();
  const allPairs = new Set(decisions.map((d) => d.pairId));
  const countFor = (pairId: string) => raters.filter((r) => byRater.get(r)!.has(pairId)).length;

  let shared = 0;
  let partial = 0;
  for (const pairId of allPairs) {
    if (countFor(pairId) === raters.length && raters.length > 1) shared += 1;
    else if (raters.length > 1) partial += 1;
  }

  const exclusiveByRater: Record<string, number> = {};
  const overlapByRater: Record<string, number> = {};
  for (const rater of raters) {
    const own = byRater.get(rater)!;
    let exclusive = 0;
    for (const pairId of own) if (countFor(pairId) === 1) exclusive += 1;
    exclusiveByRater[rater] = exclusive;
    overlapByRater[rater] = own.size ? (own.size - exclusive) / own.size : 0;
  }

  const warnings: string[] = [];
  let mismatch = false;
  if (raters.length > 1) {
    for (const rater of raters) {
      if (overlapByRater[rater] < 0.2) {
        mismatch = true;
        warnings.push(
          `${rater} shares only ${(overlapByRater[rater] * 100).toFixed(0)}% of their pairs with other raters — ` +
          "likely a different image pool or seed, so their labels cannot be aggregated.",
        );
      }
    }
    if (shared === 0) warnings.push("No pair was labelled by every rater; agreement cannot be measured.");
  }

  return {
    raters,
    sharedPairs: shared,
    partialPairs: partial,
    exclusiveByRater,
    overlapByRater,
    poolMismatchSuspected: mismatch,
    warnings,
  };
}
