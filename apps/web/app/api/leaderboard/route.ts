import { leaderboard } from "@/lib/leaderboard.mjs";

// The store is written by the Socket.IO server in this same process, so the
// response must never be cached.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const standings = await leaderboard.standings();
    return Response.json(
      { standings },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "unknown error";
    return Response.json(
      { standings: [], error: `Could not read the leaderboard: ${message}` },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
