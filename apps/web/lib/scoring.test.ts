import { describe, expect, it } from "vitest";
import {
  isCurrentScoreResult,
  localPlayerWon,
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
});
