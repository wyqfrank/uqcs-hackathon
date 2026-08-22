import { describe, expect, it } from "vitest";
import { classifyFrame } from "./frame-quality";
import { DetectionStabilizer } from "./temporal";
import { createPose } from "./test-fixtures";

const GOOD_IMAGE = { brightness: 0.5, sharpness: 0.8 };

describe("detection temporal stability", () => {
  it("requires two valid observations before producing a candidate", () => {
    const stabilizer = new DetectionStabilizer();
    const first = stabilizer.update(classifyFrame(100, [createPose()], GOOD_IMAGE, 0));
    const second = stabilizer.update(classifyFrame(200, [createPose()], GOOD_IMAGE, 0));

    expect(first.scoreable).toBe(false);
    expect(second.stableStatus).toBe("valid");
    expect(second.scoreable).toBe(true);
  });

  it("requires three invalid observations to leave stable valid", () => {
    const stabilizer = new DetectionStabilizer();
    stabilizer.update(classifyFrame(100, [createPose()], GOOD_IMAGE, 0));
    stabilizer.update(classifyFrame(200, [createPose()], GOOD_IMAGE, 0));

    const firstMiss = stabilizer.update(classifyFrame(300, [], GOOD_IMAGE, 0));
    const secondMiss = stabilizer.update(classifyFrame(400, [], GOOD_IMAGE, 0));
    const thirdMiss = stabilizer.update(classifyFrame(500, [], GOOD_IMAGE, 0));

    expect(firstMiss.stableStatus).toBe("valid");
    expect(firstMiss.scoreable).toBe(false);
    expect(secondMiss.stableStatus).toBe("valid");
    expect(thirdMiss.stableStatus).toBe("no_person");
  });

  it("expires held geometry after 300 milliseconds", () => {
    const stabilizer = new DetectionStabilizer();
    stabilizer.update(classifyFrame(100, [createPose()], GOOD_IMAGE, 0));
    const held = stabilizer.update(classifyFrame(350, [], GOOD_IMAGE, 0));
    const expired = stabilizer.update(classifyFrame(401, [], GOOD_IMAGE, 0));

    expect(held.cropBox).not.toBeNull();
    expect(expired.cropBox).toBeNull();
  });
});

