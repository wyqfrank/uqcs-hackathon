import { NextResponse } from "next/server";
import { aggregateByPair, summarise } from "@/lib/labelling/aggregate";
import { readAllDecisions } from "@/lib/labelling/store";

export const dynamic = "force-dynamic";

/**
 * Training-ready export across every rater's file.
 *
 * `Cannot judge` rows carry a null target: per the PRD they are excluded from
 * preference training and surfaced separately as frame-quality examples.
 */
export async function GET(request: Request) {
  const format = new URL(request.url).searchParams.get("format") ?? "json";
  const decisions = await readAllDecisions();
  const consensus = aggregateByPair(decisions);
  const summary = summarise(decisions, consensus);
  const preference = decisions.filter((d) => d.target !== null);
  const frameQuality = decisions.filter((d) => d.target === null);

  if (format === "csv") {
    // Raw per-decision rows, one line per rater per pair.
    const header = "pair_id,left_id,right_id,target,group,split,rater_id,cohort,engagement,latency_ms,decided_at";
    const rows = preference.map((d) =>
      [d.pairId, d.shownLeftId, d.shownRightId, d.target, d.group, d.split,
       d.raterId, d.raterCohort, d.raterEngagement, d.latencyMs, d.decidedAt].join(","),
    );
    return new NextResponse([header, ...rows].join("\n"), {
      headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="fitted-preferences.csv"' },
    });
  }

  if (format === "consensus") {
    // One row per pair: the aggregated soft label to train against.
    const header = "pair_id,mean_target,n_raters,agreement,contested,group,split";
    const rows = consensus
      .filter((c) => c.meanTarget !== null)
      .map((c) => [c.pairId, c.meanTarget!.toFixed(3), c.raters.length,
                   c.agreement.toFixed(3), c.contested, c.group, c.split].join(","));
    return new NextResponse([header, ...rows].join("\n"), {
      headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="fitted-consensus.csv"' },
    });
  }

  return NextResponse.json({ summary, consensus, preference, frameQuality });
}
