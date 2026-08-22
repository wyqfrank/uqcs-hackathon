import { describe, expect, it } from "vitest";
import { TARGET_ZOOM, resolveZoom } from "./useCamera";

describe("resolveZoom", () => {
  it("requests the ultra-wide target when the lens reaches it", () => {
    expect(resolveZoom({ min: 0.5, max: 6 })).toBe(TARGET_ZOOM);
  });

  it("clamps to the widest the hardware offers", () => {
    // A built-in laptop camera cannot go below 1x; 1x is the best it can do.
    expect(resolveZoom({ min: 1, max: 4 })).toBe(1);
  });

  it("never exceeds the maximum", () => {
    expect(resolveZoom({ min: 2, max: 3 }, 10)).toBe(3);
  });

  it("returns null when the camera does not report zoom", () => {
    expect(resolveZoom(undefined)).toBeNull();
    expect(resolveZoom({})).toBeNull();
    expect(resolveZoom({ min: 1 })).toBeNull();
  });

  it("returns null for an incoherent range rather than guessing", () => {
    expect(resolveZoom({ min: 4, max: 1 })).toBeNull();
  });
});
