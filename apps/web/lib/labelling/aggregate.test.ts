import { describe, expect, it } from "vitest";
import { aggregateByPair, reportMerge, summarise } from "./aggregate";
import type { Decision, Verdict } from "./types";

function decision(pairId: string, raterId: string, verdict: Verdict, extra: Partial<Decision> = {}): Decision {
  const target = verdict === "a" ? 1 : verdict === "b" ? 0 : verdict === "close" ? 0.5 : null;
  return {
    pairId, raterId, raterCohort: "uq", raterEngagement: 3,
    shownLeftId: "l", shownRightId: "r", shownVerdict: verdict, verdict, target,
    group: "close", split: "train", reasons: [], dimensions: {},
    latencyMs: 1000, decidedAt: "2026-08-22T00:00:00.000Z",
    ...extra,
  };
}

describe("aggregateByPair", () => {
  it("averages agreeing raters into a confident soft label", () => {
    const [c] = aggregateByPair([
      decision("p1", "a", "a"), decision("p1", "b", "a"), decision("p1", "c", "a"),
    ]);
    expect(c.meanTarget).toBe(1);
    expect(c.agreement).toBe(1);
    expect(c.contested).toBe(false);
    expect(c.raters).toHaveLength(3);
  });

  it("lands a split decision between the two outcomes rather than forcing a winner", () => {
    const [c] = aggregateByPair([
      decision("p1", "a", "a"), decision("p1", "b", "b"), decision("p1", "c", "a"),
    ]);
    expect(c.meanTarget).toBeCloseTo(2 / 3);
    expect(c.contested).toBe(true);
    expect(c.agreement).toBeCloseTo(2 / 3);
  });

  it("excludes Cannot judge from the target but keeps the vote", () => {
    const [c] = aggregateByPair([
      decision("p1", "a", "a"), decision("p1", "b", "unjudgeable"),
    ]);
    expect(c.usableCount).toBe(1);
    expect(c.meanTarget).toBe(1);
    expect(c.verdicts).toContain("unjudgeable");
  });

  it("returns a null target when nobody could judge", () => {
    const [c] = aggregateByPair([
      decision("p1", "a", "unjudgeable"), decision("p1", "b", "unjudgeable"),
    ]);
    expect(c.meanTarget).toBeNull();
    expect(c.usableCount).toBe(0);
  });

  it("treats Too close as the midpoint", () => {
    const [c] = aggregateByPair([decision("p1", "a", "close"), decision("p1", "b", "close")]);
    expect(c.meanTarget).toBe(0.5);
  });

  it("counts one vote per rater, keeping the latest", () => {
    const [c] = aggregateByPair([
      decision("p1", "a", "a", { decidedAt: "2026-08-22T00:00:00.000Z" }),
      decision("p1", "a", "b", { decidedAt: "2026-08-22T01:00:00.000Z" }),
    ]);
    expect(c.raters).toEqual(["a"]);
    expect(c.meanTarget).toBe(0);
  });

  it("aggregates dimension answers with their own agreement", () => {
    const [c] = aggregateByPair([
      decision("p1", "a", "a", { dimensions: { "Component quality": "a" } }),
      decision("p1", "b", "a", { dimensions: { "Component quality": "b" } }),
    ]);
    expect(c.dimensions["Component quality"]?.answers).toHaveLength(2);
    expect(c.dimensions["Component quality"]?.agreement).toBe(0.5);
  });
});

describe("summarise", () => {
  const decisions = [
    decision("p1", "dp", "a"), decision("p1", "angus", "a"), decision("p1", "frank", "b"),
    decision("p2", "dp", "b"), decision("p2", "angus", "b"),
    decision("p3", "dp", "close"),
  ];

  it("reports per-rater counts and shared coverage", () => {
    const s = summarise(decisions, aggregateByPair(decisions));
    expect(s.raters).toEqual(["angus", "dp", "frank"]);
    expect(s.totalDecisions).toBe(6);
    expect(s.pairsLabelled).toBe(3);
    expect(s.pairsWithMultipleRaters).toBe(2);
    expect(s.perRater).toEqual({ dp: 3, angus: 2, frank: 1 });
  });

  it("measures mean agreement across shared pairs only", () => {
    const s = summarise(decisions, aggregateByPair(decisions));
    // p1: 2/3 agree, p2: unanimous. p3 has one rater and is excluded.
    expect(s.meanAgreement).toBeCloseTo((2 / 3 + 1) / 2);
    expect(s.contestedPairs).toBe(1);
  });
});

describe("reportMerge", () => {
  it("reports full overlap when raters saw the same pairs", () => {
    const r = reportMerge([
      decision("p1", "dp", "a"), decision("p2", "dp", "b"),
      decision("p1", "angus", "a"), decision("p2", "angus", "a"),
      decision("p1", "frank", "b"), decision("p2", "frank", "b"),
    ]);
    expect(r.raters).toEqual(["angus", "dp", "frank"]);
    expect(r.sharedPairs).toBe(2);
    expect(r.partialPairs).toBe(0);
    expect(r.poolMismatchSuspected).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("flags a rater whose pool diverged", () => {
    // `rogue` ingested different photos, so none of their pair ids match.
    const shared = ["p1", "p2", "p3", "p4", "p5"].flatMap((p) => [
      decision(p, "dp", "a"), decision(p, "angus", "b"),
    ]);
    const rogue = ["x1", "x2", "x3", "x4", "x5"].map((p) => decision(p, "rogue", "a"));
    const r = reportMerge([...shared, ...rogue]);
    expect(r.poolMismatchSuspected).toBe(true);
    expect(r.overlapByRater.rogue).toBe(0);
    expect(r.exclusiveByRater.rogue).toBe(5);
    expect(r.overlapByRater.dp).toBe(1);
    expect(r.warnings.some((w) => w.includes("rogue"))).toBe(true);
  });

  it("warns when no pair was labelled by everyone", () => {
    const r = reportMerge([
      decision("p1", "dp", "a"), decision("p1", "angus", "b"),
      decision("p2", "frank", "a"),
    ]);
    expect(r.sharedPairs).toBe(0);
    expect(r.warnings.some((w) => w.includes("agreement cannot be measured"))).toBe(true);
  });

  it("stays quiet for a single rater", () => {
    const r = reportMerge([decision("p1", "dp", "a"), decision("p2", "dp", "b")]);
    expect(r.raters).toEqual(["dp"]);
    expect(r.warnings).toEqual([]);
    expect(r.poolMismatchSuspected).toBe(false);
  });
});
