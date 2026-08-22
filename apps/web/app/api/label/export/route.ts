import { NextResponse } from "next/server";
import { readDecisions } from "@/lib/labelling/store";

export const dynamic = "force-dynamic";

/**
 * Training-ready export. `Cannot judge` rows are excluded from preference
 * training per the PRD and surfaced separately as frame-quality examples.
 */
export async function GET(request: Request) {
  const format = new URL(request.url).searchParams.get("format") ?? "json";
  const decisions = await readDecisions();
  const preference = decisions.filter((d) => d.target !== null);
  const frameQuality = decisions.filter((d) => d.target === null);

  if (format === "csv") {
    const header = "pair_id,left_id,right_id,target,group,split,rater_id,cohort,engagement,latency_ms,decided_at";
    const rows = preference.map((d) =>
      [d.pairId, d.shownLeftId, d.shownRightId, d.target, d.group, d.split,
       d.raterId, d.raterCohort, d.raterEngagement, d.latencyMs, d.decidedAt].join(","),
    );
    return new NextResponse([header, ...rows].join("\n"), {
      headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="fitted-preferences.csv"' },
    });
  }

  return NextResponse.json({
    counts: {
      total: decisions.length,
      preference: preference.length,
      frameQuality: frameQuality.length,
      byGroup: preference.reduce<Record<string, number>>((acc, d) => {
        acc[d.group] = (acc[d.group] ?? 0) + 1;
        return acc;
      }, {}),
      raters: new Set(decisions.map((d) => d.raterId)).size,
    },
    preference,
    frameQuality,
  });
}
