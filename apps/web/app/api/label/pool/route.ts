import { NextResponse } from "next/server";
import { buildPairs } from "@/lib/labelling/pairing";
import { readPool } from "@/lib/labelling/store";

export const dynamic = "force-dynamic";

/** Returns the image pool plus the deterministic pair set built from it. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = Number(url.searchParams.get("target") ?? 600);
  const seed = Number(url.searchParams.get("seed") ?? 1);

  const images = await readPool();
  if (images.length < 2) {
    return NextResponse.json({ images, pairs: [], error: "pool-too-small" });
  }
  return NextResponse.json({ images, pairs: buildPairs(images, { seed, target }) });
}
