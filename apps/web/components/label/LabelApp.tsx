"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Pair, PoolImage, Rater, Split } from "@/lib/labelling/types";
import { LabelStation } from "./LabelStation";
import { RaterSetup } from "./RaterSetup";

type PoolResponse = {
  images: PoolImage[];
  pairs: Pair[];
  splits?: Split[] | null;
  error?: string;
  detail?: string;
};

/**
 * Reads `?splits=val,test` off the page URL. A second rater is usually pointed
 * at the evaluation splits, where repeat judgements de-noise the held-out
 * target instead of padding a training set that is already large enough.
 */
function requestedSplits(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("splits");
}

export function LabelApp() {
  const [rater, setRater] = useState<Rater | null>(null);
  const [pool, setPool] = useState<PoolResponse | null>(null);
  const [done, setDone] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resume the previous session rather than re-asking for cohort each reload.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("fitted.rater");
      if (stored) setRater(JSON.parse(stored) as Rater);
    } catch {
      /* private mode or blocked storage — fall through to setup */
    }
  }, []);

  const start = useCallback((next: Rater) => {
    setRater(next);
    try {
      window.localStorage.setItem("fitted.rater", JSON.stringify(next));
    } catch {
      /* non-fatal: the session just will not resume after a reload */
    }
  }, []);

  useEffect(() => {
    if (!rater) return;
    let cancelled = false;
    (async () => {
      try {
        const splits = requestedSplits();
        const poolUrl = splits
          ? `/api/label/pool?splits=${encodeURIComponent(splits)}`
          : "/api/label/pool";
        const [poolRes, decisionsRes] = await Promise.all([
          fetch(poolUrl),
          fetch(`/api/label/decisions?raterId=${encodeURIComponent(rater.id)}`),
        ]);
        if (!poolRes.ok || !decisionsRes.ok) throw new Error("Request failed");
        const poolJson = (await poolRes.json()) as PoolResponse;
        const decisionsJson = (await decisionsRes.json()) as { decisions: { pairId: string }[] };
        if (cancelled) return;
        setPool(poolJson);
        setDone(decisionsJson.decisions.map((d) => d.pairId));
      } catch {
        if (!cancelled) setError("Could not load the image pool. Is the dev server running?");
      }
    })();
    return () => { cancelled = true; };
  }, [rater]);

  if (!rater) return <RaterSetup onStart={start} />;

  if (error) {
    return (
      <div className="label-empty">
        <h1>Something went wrong</h1>
        <p>{error}</p>
      </div>
    );
  }

  if (!pool || !done) return <div className="label-empty"><p>Loading pool…</p></div>;

  if (pool.error === "bad-splits") {
    return (
      <div className="label-empty">
        <h1>That split does not exist</h1>
        <p>{pool.detail}</p>
        <p>
          Example: <code>/label?splits=val,test</code>
        </p>
      </div>
    );
  }

  // A valid subset that happens to be empty is a different problem from an
  // empty pool, and the fix is different too.
  if (pool.splits && pool.pairs.length === 0) {
    return (
      <div className="label-empty">
        <h1>No pairs in {pool.splits.join(" or ")}</h1>
        <p>
          The pool built no pairs for {pool.splits.length > 1 ? "these splits" : "this split"}.
          Try <code>/label</code> without a filter to rate the whole set.
        </p>
      </div>
    );
  }

  if (pool.error === "pool-too-small" || pool.pairs.length === 0) {
    return (
      <div className="label-empty">
        <h1>No images to rate yet</h1>
        <p>
          Drop outfit photos into <code>apps/web/public/label-pool/</code> using the
          filename pattern <code>&lt;subject&gt;__&lt;tier&gt;__&lt;note&gt;.jpg</code>, for
          example <code>s01__high__front.jpg</code>. At least two subjects are needed.
        </p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }

  return (
    <LabelStation
      rater={rater}
      images={pool.images}
      pairs={pool.pairs}
      alreadyDone={done}
      splits={pool.splits ?? null}
    />
  );
}
