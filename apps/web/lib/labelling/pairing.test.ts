import { describe, expect, it } from "vitest";
import { assignSplits, buildPairs, isMirroredFor, makeRng } from "./pairing";
import type { PoolImage } from "./types";

function pool(count: number): PoolImage[] {
  const tiers = ["high", "mid", "low"] as const;
  return assignSplits(
    Array.from({ length: count }, (_, i) => ({
      id: `img-${i}`,
      src: `/label-pool/img-${i}.jpg`,
      subjectId: `subject-${Math.floor(i / 2)}`,
      tier: tiers[i % 3],
    })),
  );
}

describe("makeRng", () => {
  it("is deterministic for a seed", () => {
    expect([makeRng(7)(), makeRng(7)()]).toEqual([makeRng(7)(), makeRng(7)()]);
  });
});

describe("assignSplits", () => {
  it("keeps every image of a subject in one split", () => {
    const bySubject = new Map<string, Set<string>>();
    for (const image of pool(120)) {
      const set = bySubject.get(image.subjectId) ?? new Set();
      set.add(image.split);
      bySubject.set(image.subjectId, set);
    }
    for (const splits of bySubject.values()) expect(splits.size).toBe(1);
  });

  it("is stable when new images are appended", () => {
    const first = assignSplits(pool(40).map(({ split: _split, ...rest }) => rest));
    const grown = assignSplits(pool(80).map(({ split: _split, ...rest }) => rest));
    for (const image of first) {
      expect(grown.find((other) => other.id === image.id)?.split).toBe(image.split);
    }
  });
});

describe("buildPairs", () => {
  const images = pool(120);
  const pairs = buildPairs(images, { seed: 42, target: 200 });
  const byId = new Map(images.map((image) => [image.id, image]));

  it("never pairs an image with itself or its own subject", () => {
    for (const pair of pairs) {
      expect(pair.leftId).not.toBe(pair.rightId);
      expect(byId.get(pair.leftId)!.subjectId).not.toBe(byId.get(pair.rightId)!.subjectId);
    }
  });

  it("never crosses a split boundary", () => {
    for (const pair of pairs) {
      expect(byId.get(pair.leftId)!.split).toBe(pair.split);
      expect(byId.get(pair.rightId)!.split).toBe(pair.split);
    }
  });

  it("emits no duplicate pairs", () => {
    expect(new Set(pairs.map((p) => p.id)).size).toBe(pairs.length);
  });

  it("builds all three groups", () => {
    expect(new Set(pairs.map((p) => p.group))).toEqual(new Set(["clear", "close", "robustness"]));
  });

  it("contrasts tiers for clear pairs and matches them otherwise", () => {
    for (const pair of pairs) {
      const a = byId.get(pair.leftId)!.tier;
      const b = byId.get(pair.rightId)!.tier;
      if (pair.group === "clear") expect(a).not.toBe(b);
      else expect(a).toBe(b);
    }
  });

  it("keeps the dimension subset near the PRD's 20-30%", () => {
    const rate = pairs.filter((p) => p.askDimensions).length / pairs.length;
    expect(rate).toBeGreaterThan(0.15);
    expect(rate).toBeLessThan(0.35);
  });

  it("is reproducible for a seed", () => {
    expect(buildPairs(images, { seed: 42, target: 200 }).map((p) => p.id)).toEqual(pairs.map((p) => p.id));
  });
});

describe("isMirroredFor", () => {
  it("is stable per rater but varies across raters", () => {
    expect(isMirroredFor("p1", "rater-a")).toBe(isMirroredFor("p1", "rater-a"));
    const raters = Array.from({ length: 40 }, (_, i) => isMirroredFor("p1", `rater-${i}`));
    expect(new Set(raters).size).toBe(2);
  });
});
