export type PlayerScoreBreakdown = {
  componentQuality: number;
  outfitCoordination: number;
  bodyFit: number;
  vlmHolistic: number | null;
  observations: string[];
};

export type FinalScoreResult = {
  phase: "final";
  battleId: string;
  finalisationId: string;
  pairId: string;
  playerASampleId: string;
  playerBSampleId: string;
  playerACapturedAtMs: number;
  playerBCapturedAtMs: number;
  modelVersion: string;
  promptVersion: string;
  scoringVersion: string;
  playerAScore: number;
  playerBScore: number;
  winner: "player_a" | "player_b" | "draw";
  winProbability: null;
  breakdown: {
    playerA: PlayerScoreBreakdown;
    playerB: PlayerScoreBreakdown;
  };
  frameQuality: {
    playerA: "ok" | "poor" | "unusable";
    playerB: "ok" | "poor" | "unusable";
  };
  explanation: string;
  latencyMs: number;
};

export type NotScoreableResult = {
  phase: "not_scoreable";
  intendedPhase: "final";
  battleId: string;
  finalisationId: string;
  pairId: string | null;
  playerASampleId: string | null;
  playerBSampleId: string | null;
  playerACapturedAtMs: number | null;
  playerBCapturedAtMs: number | null;
  reasonCode: string;
  message: string;
  retryable: boolean;
  modelVersion: string | null;
  promptVersion: string | null;
  latencyMs: number;
};

export type ScoreResult = FinalScoreResult | NotScoreableResult;

export type BattleScoringState =
  | { phase: "ready" }
  | { phase: "collecting"; finalisationId: string }
  | { phase: "analysing"; finalisationId: string }
  | { phase: "final"; result: FinalScoreResult }
  | { phase: "not_scoreable"; result: NotScoreableResult };

export function scoresForRole(result: FinalScoreResult, role: "host" | "guest") {
  return role === "host"
    ? { localScore: result.playerAScore, remoteScore: result.playerBScore }
    : { localScore: result.playerBScore, remoteScore: result.playerAScore };
}

export function localPlayerWon(result: FinalScoreResult, role: "host" | "guest") {
  return (
    (result.winner === "player_a" && role === "host")
    || (result.winner === "player_b" && role === "guest")
  );
}

export function isCurrentScoreResult(
  result: ScoreResult,
  roomId: string,
  activeFinalisationId: string | null,
) {
  return result.battleId === roomId
    && (!activeFinalisationId || result.finalisationId === activeFinalisationId);
}
