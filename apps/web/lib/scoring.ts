export type PlayerScoreBreakdown = {
  componentQuality: number;
  outfitCoordination: number;
  bodyFit: number;
  vlmHolistic: number | null;
  observations: string[];
};

export type ScoreSamplePair = {
  burstIndex: number;
  playerASampleId: string;
  playerBSampleId: string;
  playerACapturedAtMs: number;
  playerBCapturedAtMs: number;
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
  samplePairs: ScoreSamplePair[];
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
  samplePairs: ScoreSamplePair[];
  reasonCode: string;
  message: string;
  retryable: boolean;
  modelVersion: string | null;
  promptVersion: string | null;
  latencyMs: number;
};

export type ScoreResult = FinalScoreResult | NotScoreableResult;

export type BattleScoringState =
  | {
      phase: "waiting_ready";
      playerAReady: boolean;
      playerBReady: boolean;
    }
  /** Lead-in: both clients count down together before scoring opens. */
  | { phase: "starting"; roundId: string; secondsRemaining: number }
  | { phase: "countdown"; roundId: string; secondsRemaining: number }
  | { phase: "collecting"; finalisationId: string }
  | { phase: "analysing"; finalisationId: string }
  | { phase: "final"; result: FinalScoreResult }
  | { phase: "not_scoreable"; result: NotScoreableResult };

export function countdownSeconds(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export type ProvisionalScorePair = {
  playerA: number;
  playerB: number;
};

const PROVISIONAL_MINIMUM = 55;
const PROVISIONAL_MAXIMUM = 85;

function seededUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0xffffffff;
}

export function provisionalScoresForRound(
  roundId: string,
  secondsRemaining: number,
): ProvisionalScorePair {
  const timeSlice = Math.floor(Math.max(0, secondsRemaining) * 2);
  const score = (role: "player_a" | "player_b") => {
    const base = 62 + seededUnit(`${roundId}:${role}:base`) * 16;
    const movement = (seededUnit(`${roundId}:${role}:${timeSlice}`) - 0.5) * 6;
    return Math.round(
      Math.max(PROVISIONAL_MINIMUM, Math.min(PROVISIONAL_MAXIMUM, base + movement)) * 10,
    ) / 10;
  };
  return { playerA: score("player_a"), playerB: score("player_b") };
}

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
