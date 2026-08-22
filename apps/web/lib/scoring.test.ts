import { describe, expect, it } from "vitest";
import {
  countdownSeconds,
  isCurrentScoreResult,
  localPlayerWon,
  provisionalScoresForRound,
  scoresForRole,
  type FinalScoreResult,
} from "./scoring";

const result = {
  phase: "final",
  battleId: "FIT-1234",
  finalisationId: "final-1",
  pairId: "pair-1",
  playerAScore: 82,
  playerBScore: 71,
  winner: "player_a",
} as FinalScoreResult;

describe("authoritative score presentation", () => {
  it("maps server player identity into each client's local perspective", () => {
    expect(scoresForRole(result, "host")).toEqual({ localScore: 82, remoteScore: 71 });
    expect(scoresForRole(result, "guest")).toEqual({ localScore: 71, remoteScore: 82 });
    expect(localPlayerWon(result, "host")).toBe(true);
    expect(localPlayerWon(result, "guest")).toBe(false);
  });

  it("rejects results for a stale finalisation or another room", () => {
    expect(isCurrentScoreResult(result, "FIT-1234", "final-1")).toBe(true);
    expect(isCurrentScoreResult(result, "FIT-1234", "final-2")).toBe(false);
    expect(isCurrentScoreResult(result, "FIT-9999", "final-1")).toBe(false);
  });

  it("accepts a locked reconnect result when no finalisation is active locally", () => {
    expect(isCurrentScoreResult(result, "FIT-1234", null)).toBe(true);
  });

  it("renders a ceiling-based countdown without crossing below zero", () => {
    expect(countdownSeconds(30_000, 0)).toBe(30);
    expect(countdownSeconds(30_000, 1)).toBe(30);
    expect(countdownSeconds(30_000, 29_001)).toBe(1);
    expect(countdownSeconds(30_000, 30_000)).toBe(0);
    expect(countdownSeconds(30_000, 31_000)).toBe(0);
  });

  it("creates shared deterministic live estimates inside the demo range", () => {
    const first = provisionalScoresForRound("round-1", 30);
    expect(provisionalScoresForRound("round-1", 30)).toEqual(first);
    expect(first.playerA).toBeGreaterThanOrEqual(55);
    expect(first.playerA).toBeLessThanOrEqual(85);
    expect(first.playerB).toBeGreaterThanOrEqual(55);
    expect(first.playerB).toBeLessThanOrEqual(85);
  });

  it("holds a live estimate for three-second slices before updating", () => {
    expect(provisionalScoresForRound("round-1", 29)).toEqual(
      provisionalScoresForRound("round-1", 28),
    );
  });
});
