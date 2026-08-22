import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GarmentOverlay } from "../lib/garmentPerception";
import { GarmentDetectionOverlay } from "./GarmentDetectionOverlay";

describe("GarmentDetectionOverlay", () => {
  it("projects crop-relative boxes and mirrors them onto the displayed video", () => {
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = { videoWidth: 1000, videoHeight: 500 } as HTMLVideoElement;
    const overlay: GarmentOverlay = {
      cropBox: { x: 0.2, y: 0.1, width: 0.5, height: 0.8 },
      detections: [{
        category: "top",
        matchedPrompt: "shirt/blouse",
        confidence: 0.91,
        box: { x: 0.1, y: 0.25, width: 0.2, height: 0.5 },
      }],
    };

    const markup = renderToStaticMarkup(
      <GarmentDetectionOverlay videoRef={videoRef} overlay={overlay} />,
    );

    const rectangle = markup.match(
      /<rect[^>]+x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/,
    );
    expect(rectangle).not.toBeNull();
    expect(Number(rectangle![1])).toBeCloseTo(650);
    expect(Number(rectangle![2])).toBeCloseTo(150);
    expect(Number(rectangle![3])).toBeCloseTo(100);
    expect(Number(rectangle![4])).toBeCloseTo(200);
    expect(markup).toContain("TOP 91");
  });

  it("renders nothing when no garment boxes were detected", () => {
    const videoRef = createRef<HTMLVideoElement>();
    expect(renderToStaticMarkup(
      <GarmentDetectionOverlay
        videoRef={videoRef}
        overlay={{
          cropBox: { x: 0, y: 0, width: 1, height: 1 },
          detections: [],
        }}
      />,
    )).toBe("");
  });
});
