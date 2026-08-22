import { NextResponse } from "next/server";
import { buildPairs } from "@/lib/labelling/pairing";
import { readPool } from "@/lib/labelling/store";
import type { Split } from "@/lib/labelling/types";

export const dynamic = "force-dynamic";

const SPLITS: readonly Split[] = ["train", "val", "test"];

/**
 * Parses `?splits=val,test`. Returns `null` when the parameter is absent, which
 * serves every pair exactly as before.
 */
function parseSplits(raw: string | null): { splits: Split[] } | { error: string } | null {
  if (raw === null) return null;
  const parsed = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parsed.length === 0) return { error: "splits was empty" };
  const unknown = parsed.filter((part) => !SPLITS.includes(part as Split));
  if (unknown.length > 0) {
    return { error: `unknown split: ${unknown.join(", ")}. Use train, val or test.` };
  }
  return { splits: [...new Set(parsed as Split[])] };
}

/** Returns the image pool plus the deterministic pair set built from it. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = Number(url.searchParams.get("target") ?? 600);
  const seed = Number(url.searchParams.get("seed") ?? 1);

  const requested = parseSplits(url.searchParams.get("splits"));
  if (requested && "error" in requested) {
    return NextResponse.json({ images: [], pairs: [], error: "bad-splits", detail: requested.error });
  }

  const images = await readPool();
  if (images.length < 2) {
    return NextResponse.json({ images, pairs: [], error: "pool-too-small" });
  }

  // Pairs are always built from the whole pool, then filtered. Building from a
  // subset would change the rng draws and therefore the pair ids, orphaning
  // every decision already collected against the full set.
  const all = buildPairs(images, { seed, target });
  const splits = requested?.splits ?? null;
  const pairs = splits ? all.filter((pair) => splits.includes(pair.split)) : all;

  return NextResponse.json({ images, pairs, splits });
}
