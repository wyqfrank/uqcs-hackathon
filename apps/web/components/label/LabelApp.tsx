"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Pair, PoolImage, Rater } from "@/lib/labelling/types";
import { LabelStation } from "./LabelStation";
import { RaterSetup } from "./RaterSetup";

type PoolResponse = { images: PoolImage[]; pairs: Pair[]; error?: string };

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
        const [poolRes, decisionsRes] = await Promise.all([
          fetch("/api/label/pool"),
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

  return <LabelStation rater={rater} images={pool.images} pairs={pool.pairs} alreadyDone={done} />;
}
