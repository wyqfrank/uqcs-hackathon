import { describe, expect, it } from "vitest";
import { assignSplits, availableGroups, buildPairs, isMirroredFor, makeRng } from "./pairing";
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

  it("builds only the groups the metadata supports", () => {
    // This fixture has tiers but no outfitTag, so robustness is not constructible.
    expect(new Set(pairs.map((p) => p.group))).toEqual(new Set(["clear", "close"]));
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

describe("availableGroups", () => {
  const bare = (n: number) =>
    assignSplits(
      Array.from({ length: n }, (_, i) => ({
        id: `b-${i}`,
        src: `/label-pool/b-${i}.jpg`,
        subjectId: `b-${i}`,
      })),
    );

  it("falls back to close only for an untagged, untiered flat pool", () => {
    expect(availableGroups(bare(20))).toEqual(["close"]);
  });

  it("adds clear once tiers exist", () => {
    const tiered = bare(20).map((image, i) => ({ ...image, tier: (["high", "low"] as const)[i % 2] }));
    expect(availableGroups(tiered)).toEqual(["clear", "close"]);
  });

  it("adds robustness only when an outfit tag is shared", () => {
    const unique = bare(6).map((image, i) => ({ ...image, outfitTag: `tag-${i}` }));
    expect(availableGroups(unique)).not.toContain("robustness");
    const shared = bare(6).map((image, i) => ({ ...image, outfitTag: `tag-${i % 2}` }));
    expect(availableGroups(shared)).toContain("robustness");
  });
});

describe("flat pool (no metadata)", () => {
  const flat = assignSplits(
    Array.from({ length: 60 }, (_, i) => ({
      id: `f-${i}`,
      src: `/label-pool/f-${i}.jpg`,
      subjectId: `f-${i}`,
    })),
  );

  it("still produces pairs, all labelled close", () => {
    const pairs = buildPairs(flat, { seed: 3, target: 120 });
    expect(pairs.length).toBeGreaterThan(20);
    expect(new Set(pairs.map((p) => p.group))).toEqual(new Set(["close"]));
  });

  it("never pairs an image with itself", () => {
    for (const pair of buildPairs(flat, { seed: 3, target: 120 })) {
      expect(pair.leftId).not.toBe(pair.rightId);
    }
  });
});
