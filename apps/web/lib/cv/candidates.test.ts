import { describe, expect, it, vi } from "vitest";
import { CandidateFrameBuffer, candidateQualityScore } from "./candidates";
import { createQuality } from "./test-fixtures";
import type { CandidateFrame } from "./types";

function candidate(capturedAt: number, quality = createQuality()) {
  const close = vi.fn();
  return {
    value: {
      capturedAt,
      crop: { close } as unknown as ImageBitmap,
      quality,
      visibleRegions: { head: true, torso: true, legs: true, feet: false },
    } satisfies CandidateFrame,
    close,
  };
}

describe("candidate selection", () => {
  it("uses the weighted quality formula", () => {
    const sharp = candidateQualityScore(createQuality({ sharpness: 1 }));
    const blurry = candidateQualityScore(createQuality({ sharpness: 0 }));
    expect(sharp).toBeGreaterThan(blurry);
  });

  it("selects the newest candidate when quality is tied", () => {
    const buffer = new CandidateFrameBuffer();
    const oldCandidate = candidate(100);
    const newCandidate = candidate(200);
    buffer.add(oldCandidate.value, 200);
    buffer.add(newCandidate.value, 200);

    expect(buffer.consumeBest(200)?.capturedAt).toBe(200);
    buffer.clear();
    expect(oldCandidate.close).toHaveBeenCalledOnce();
  });

  it("closes expired and overflow bitmap resources", () => {
    const buffer = new CandidateFrameBuffer();
    const frames = Array.from({ length: 6 }, (_, index) => candidate(100 + index));
    for (const frame of frames) buffer.add(frame.value, 105);

    expect(buffer.size).toBe(5);
    expect(frames[0].close).toHaveBeenCalledOnce();

    expect(buffer.consumeBest(500)).toBeNull();
    for (const frame of frames.slice(1)) expect(frame.close).toHaveBeenCalledOnce();
  });
});

