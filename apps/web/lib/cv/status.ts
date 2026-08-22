import type { DetectorState, OutfitDetectionResult, OutfitFrameStatus } from "./types";

/**
 * The one place framing states are turned into words.
 *
 * Both the camera overlay and the live-score readout tell a player why they
 * are not being scored, and they have to say the same thing — two vocabularies
 * for one state is how a UI starts contradicting itself.
 */
export const STATUS_LABELS: Record<Exclude<OutfitFrameStatus, "valid">, string> = {
  no_person: "STEP INTO FRAME",
  multiple_people: "ONLY ONE PERSON",
  partial_outfit: "SHOW MORE OF YOUR FIT",
  too_close: "STEP BACK",
  too_far: "MOVE CLOSER",
  low_light: "MORE LIGHT NEEDED",
  blurred: "HOLD STILL",
  moving_too_fast: "HOLD STILL",
  detector_unavailable: "DETECTOR UNAVAILABLE",
};

export function guidanceLabel(
  state: DetectorState,
  result: OutfitDetectionResult | null,
) {
  if (state === "loading") return "LOADING FIT DETECTOR";
  if (state === "unavailable" || !result) return "DETECTOR UNAVAILABLE";
  if (result.observedStatus !== "valid") return STATUS_LABELS[result.observedStatus];
  return result.scoreable ? "FIT READY" : "HOLD STILL";
}
