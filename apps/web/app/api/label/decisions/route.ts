import { NextResponse } from "next/server";
import { appendDecision, readDecisions } from "@/lib/labelling/store";
import type { Decision } from "@/lib/labelling/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const raterId = new URL(request.url).searchParams.get("raterId");
  const decisions = await readDecisions();
  return NextResponse.json({
    decisions: raterId ? decisions.filter((d) => d.raterId === raterId) : decisions,
    total: decisions.length,
  });
}

export async function POST(request: Request) {
  const decision = (await request.json()) as Decision;
  if (!decision?.pairId || !decision?.raterId || !decision?.shownVerdict) {
    return NextResponse.json({ error: "pairId, raterId and shownVerdict are required" }, { status: 400 });
  }
  await appendDecision(decision);
  return NextResponse.json({ ok: true });
}
