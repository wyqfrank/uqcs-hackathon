export type FittedResult = {
  score: number;
  confidence?: number;
};

export async function inferFrame(frame: Blob): Promise<FittedResult> {
  // Replace this function body with the real model/API call. The frame is already
  // resized and encoded, and the inference loop provides backpressure.
  await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 90));
  const sizeVariation = (frame.size % 17) / 17;
  return {
    score: 68 + sizeVariation * 18 + (Math.random() - 0.5) * 6,
    confidence: 0.91,
  };
}

export function smoothScore(
  previousScore: number | null,
  latestScore: number,
  alpha = 0.2,
): number {
  if (previousScore === null) return latestScore;
  return alpha * latestScore + (1 - alpha) * previousScore;
}

export function determineWinner(
  player1Score: number,
  player2Score: number,
): "player1" | "player2" | "draw" {
  if (Math.abs(player1Score - player2Score) < 2) return "draw";
  return player1Score > player2Score ? "player1" : "player2";
}
