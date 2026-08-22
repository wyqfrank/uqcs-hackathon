import type { BattleScoringState, FinalScoreResult, NotScoreableResult } from "@/lib/scoring";

/**
 * Mock battle states for the dev-only preview. Every one of these is either
 * awkward or near-impossible to reach deliberately in a real session: a draw
 * needs two near-identical outfits, `collecting` lasts a fraction of a second,
 * and a mid-round disconnect needs the network pulled at the right moment.
 */

const breakdown = (componentQuality: number, outfitCoordination: number, bodyFit: number) =>
  ({ componentQuality, outfitCoordination, bodyFit }) as FinalScoreResult["breakdown"]["playerA"];

function finalResult(
  a: number,
  b: number,
  winner: FinalScoreResult["winner"],
  explanation: string,
): FinalScoreResult {
  return {
    phase: "final",
    battleId: "preview", finalisationId: `preview-${winner}-${a}`, pairId: "pair",
    playerASampleId: "sa", playerBSampleId: "sb",
    playerACapturedAtMs: 0, playerBCapturedAtMs: 0, samplePairs: [],
    modelVersion: "preview", promptVersion: "preview", scoringVersion: "preview",
    playerAScore: a, playerBScore: b, winner, winProbability: null,
    breakdown: { playerA: breakdown(a + 1.8, a - 1.4, a - 0.3), playerB: breakdown(b - 3.6, b + 2.3, b + 1.2) },
    frameQuality: { playerA: "ok", playerB: "ok" },
    explanation,
    latencyMs: 2400,
  };
}

export type Scenario = {
  id: string;
  label: string;
  state: BattleScoringState;
  /** Overrides applied on top of a healthy connected battle. */
  connectionState?: "searching" | "connecting" | "connected" | "disconnected" | "failed" | "error";
  connectionError?: string;
  cameraStatus?: "ready" | "requesting" | "denied" | "unavailable";
  cameraError?: string;
  hasLocalStream?: boolean;
  hasRemoteStream?: boolean;
  scores?: [number | null, number | null];
  provisional?: boolean;
};

export const SCENARIOS: Scenario[] = [
  {
    id: "waiting-neither", label: "Waiting · neither ready",
    state: { phase: "waiting_ready", playerAReady: false, playerBReady: false },
  },
  {
    id: "waiting-you", label: "Waiting · you ready",
    state: { phase: "waiting_ready", playerAReady: true, playerBReady: false },
  },
  {
    id: "countdown", label: "Countdown",
    state: { phase: "countdown", roundId: "r1", secondsRemaining: 3 },
    scores: [74.2, 71.8], provisional: true,
  },
  {
    id: "collecting", label: "Collecting frames",
    state: { phase: "collecting", finalisationId: "f1" },
    scores: [74.2, 71.8], provisional: true,
  },
  {
    id: "analysing", label: "Analysing",
    state: { phase: "analysing", finalisationId: "f1" },
    scores: [74.2, 71.8], provisional: true,
  },
  {
    id: "final-win", label: "Final · you win",
    state: {
      phase: "final",
      result: finalResult(82.4, 76.1, "player_a",
        "Your layering reads as deliberate: the open overshirt frames a clean base and the trouser break sits right on the shoe. Their pieces are individually strong but the proportions fight each other through the midsection."),
    },
  },
  {
    id: "final-loss", label: "Final · you lose",
    state: {
      phase: "final",
      result: finalResult(68.9, 81.7, "player_b",
        "Their silhouette holds a consistent line from shoulder to hem. Your top and trouser are each strong, but the volumes compete rather than balance."),
    },
  },
  {
    id: "final-draw", label: "Final · draw",
    state: {
      phase: "final",
      result: finalResult(79.4, 79.2, "draw",
        "Both looks are coherent and well proportioned, resolving different briefs equally well. There is no meaningful gap between them."),
    },
  },
  {
    id: "not-scoreable", label: "Not scoreable",
    state: {
      phase: "not_scoreable",
      result: {
        phase: "not_scoreable", intendedPhase: "final", battleId: "preview",
        finalisationId: "f2", pairId: null,
        playerASampleId: null, playerBSampleId: null,
        playerACapturedAtMs: null, playerBCapturedAtMs: null, samplePairs: [],
        reasonCode: "frame_quality",
        message: "Neither outfit was fully in frame. Step back and try again.",
        retryable: true, modelVersion: null, promptVersion: null, latencyMs: 900,
      },
    },
  },
  {
    id: "camera-denied", label: "Camera denied",
    state: { phase: "waiting_ready", playerAReady: false, playerBReady: false },
    cameraStatus: "denied", hasLocalStream: false,
    cameraError: "Camera access was denied. Enable camera permission in your browser and try again.",
  },
  {
    id: "searching", label: "Waiting for opponent",
    state: { phase: "waiting_ready", playerAReady: false, playerBReady: false },
    connectionState: "searching", hasRemoteStream: false,
  },
  {
    id: "signal-lost", label: "Connection lost",
    state: { phase: "waiting_ready", playerAReady: true, playerBReady: false },
    connectionState: "disconnected", hasRemoteStream: false,
    connectionError: "Your opponent dropped out. Wait for them to rejoin, or start a new battle.",
  },
];
