"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { isMirroredFor } from "@/lib/labelling/pairing";
import {
  DIMENSIONS,
  REASON_TAGS,
  unmirrorVerdict,
  verdictToTarget,
  type Decision,
  type Dimension,
  type DimensionAnswer,
  type Pair,
  type PoolImage,
  type Rater,
  type ReasonTag,
  type Verdict,
} from "@/lib/labelling/types";

type Stage = "verdict" | "reasons" | "dimensions";

const VERDICT_KEYS: Record<string, Verdict> = {
  a: "a", arrowleft: "a",
  b: "b", arrowright: "b",
  t: "close",
  x: "unjudgeable",
};

export function LabelStation({
  rater,
  images,
  pairs,
  alreadyDone,
}: {
  rater: Rater;
  images: PoolImage[];
  pairs: Pair[];
  alreadyDone: string[];
}) {
  const byId = useMemo(() => new Map(images.map((image) => [image.id, image])), [images]);
  const queue = useMemo(() => {
    const done = new Set(alreadyDone);
    return pairs.filter((pair) => !done.has(pair.id));
  }, [pairs, alreadyDone]);

  const [index, setIndex] = useState(0);
  const [stage, setStage] = useState<Stage>("verdict");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [reasons, setReasons] = useState<ReasonTag[]>([]);
  const [dimensions, setDimensions] = useState<Partial<Record<Dimension, DimensionAnswer>>>({});
  const [saved, setSaved] = useState(alreadyDone.length);
  const shownAt = useRef(Date.now());
  const startedAt = useRef(Date.now());

  const pair = queue[index];
  const mirrored = pair ? isMirroredFor(pair.id, rater.id) : false;
  const leftImage = pair ? byId.get(mirrored ? pair.rightId : pair.leftId) : undefined;
  const rightImage = pair ? byId.get(mirrored ? pair.leftId : pair.rightId) : undefined;

  // Preload the next two pairs so advancing never waits on the network.
  useEffect(() => {
    for (const next of queue.slice(index + 1, index + 3)) {
      for (const id of [next.leftId, next.rightId]) {
        const src = byId.get(id)?.src;
        if (src) { const img = new Image(); img.src = src; }
      }
    }
  }, [index, queue, byId]);

  useEffect(() => {
    shownAt.current = Date.now();
    setStage("verdict");
    setVerdict(null);
    setReasons([]);
    setDimensions({});
  }, [index]);

  const commit = useCallback(
    async (finalVerdict: Verdict, finalReasons: ReasonTag[], finalDimensions: typeof dimensions) => {
      if (!pair) return;
      const decision: Decision = {
        pairId: pair.id,
        raterId: rater.id,
        raterCohort: rater.cohort,
        raterEngagement: rater.engagement,
        shownLeftId: (mirrored ? pair.rightId : pair.leftId),
        shownRightId: (mirrored ? pair.leftId : pair.rightId),
        shownVerdict: finalVerdict,
        verdict: unmirrorVerdict(finalVerdict, mirrored),
        target: verdictToTarget(unmirrorVerdict(finalVerdict, mirrored)),
        group: pair.group,
        split: pair.split,
        reasons: finalReasons,
        dimensions: finalDimensions,
        latencyMs: Date.now() - shownAt.current,
        decidedAt: new Date().toISOString(),
      };
      setSaved((n) => n + 1);
      setIndex((i) => i + 1);
      // Fire-and-forget: the rater should never wait on the disk write.
      void fetch("/api/label/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decision),
      });
    },
    [pair, rater, mirrored],
  );

  const chooseVerdict = useCallback(
    (next: Verdict) => {
      if (!pair) return;
      setVerdict(next);
      const wantsReasons = pair.askReasons && (next === "a" || next === "b");
      if (wantsReasons) return setStage("reasons");
      if (pair.askDimensions) return setStage("dimensions");
      void commit(next, [], {});
    },
    [pair, commit],
  );

  const finishReasons = useCallback(() => {
    if (!pair || !verdict) return;
    if (pair.askDimensions) return setStage("dimensions");
    void commit(verdict, reasons, {});
  }, [pair, verdict, reasons, commit]);

  // Keyboard is the primary input: the whole point is throughput.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (stage === "verdict") {
        const chosen = VERDICT_KEYS[key];
        if (chosen) { event.preventDefault(); chooseVerdict(chosen); }
        return;
      }
      if (stage === "reasons") {
        const slot = Number(key);
        if (slot >= 1 && slot <= REASON_TAGS.length) {
          event.preventDefault();
          const tag = REASON_TAGS[slot - 1];
          setReasons((current) =>
            current.includes(tag)
              ? current.filter((t) => t !== tag)
              : current.length < 2 ? [...current, tag] : current,
          );
        }
        if (key === "enter") { event.preventDefault(); finishReasons(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, chooseVerdict, finishReasons]);

  if (!pair || !leftImage || !rightImage) {
    const rate = saved / Math.max(1, (Date.now() - startedAt.current) / 60000);
    return (
      <div className="label-done">
        <h1>Queue complete</h1>
        <p>{saved} decisions recorded — roughly {rate.toFixed(1)} per minute.</p>
        <div className="label-done-actions">
          <Button onClick={() => window.open("/api/label/export?format=csv", "_blank")}>
            Download CSV
          </Button>
          <Button variant="outline" onClick={() => window.open("/api/label/export", "_blank")}>
            View JSON
          </Button>
        </div>
      </div>
    );
  }

  const done = saved;
  const total = pairs.length;

  return (
    <div className="label-station">
      <header className="label-bar">
        <span>{rater.id} · {rater.cohort}</span>
        <div className="label-progress"><i style={{ width: `${(done / total) * 100}%` }} /></div>
        <span className="tabular-nums">{done} / {total}</span>
      </header>

      <p className="label-prompt">
        Which outfit is better styled as a complete look?
        <small>Judge the clothing, coordination and fit — not the person, photo quality or brand.</small>
      </p>

      <div className="label-pair">
        {[leftImage, rightImage].map((image, i) => (
          <figure key={image.id} className="label-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.src} alt={i === 0 ? "Outfit A" : "Outfit B"} />
            <figcaption>{i === 0 ? "A" : "B"}</figcaption>
          </figure>
        ))}
      </div>

      {stage === "verdict" && (
        <div className="label-actions">
          <Button onClick={() => chooseVerdict("a")}>A wins <kbd>A</kbd></Button>
          <Button onClick={() => chooseVerdict("b")}>B wins <kbd>B</kbd></Button>
          <Button variant="outline" onClick={() => chooseVerdict("close")}>Too close <kbd>T</kbd></Button>
          <Button variant="outline" onClick={() => chooseVerdict("unjudgeable")}>Cannot judge <kbd>X</kbd></Button>
        </div>
      )}

      {stage === "reasons" && (
        <div className="label-followup">
          <p>What most influenced your choice? Select up to two.</p>
          <div className="label-tags">
            {REASON_TAGS.map((tag, i) => (
              <Button
                key={tag}
                variant={reasons.includes(tag) ? "default" : "outline"}
                onClick={() =>
                  setReasons((current) =>
                    current.includes(tag)
                      ? current.filter((t) => t !== tag)
                      : current.length < 2 ? [...current, tag] : current,
                  )
                }
              >
                {tag} <kbd>{i + 1}</kbd>
              </Button>
            ))}
          </div>
          <Button onClick={finishReasons}>Continue <kbd>↵</kbd></Button>
        </div>
      )}

      {stage === "dimensions" && verdict && (
        <div className="label-followup">
          <p>For each, which outfit is stronger?</p>
          {DIMENSIONS.map((dimension) => (
            <div key={dimension} className="label-dimension">
              <span>{dimension}</span>
              <div className="label-tags">
                {(["a", "b", "equal", "unjudgeable"] as const).map((answer) => (
                  <Button
                    key={answer}
                    variant={dimensions[dimension] === answer ? "default" : "outline"}
                    onClick={() => setDimensions((current) => ({ ...current, [dimension]: answer }))}
                  >
                    {answer === "a" ? "A" : answer === "b" ? "B" : answer === "equal" ? "Equal" : "Cannot judge"}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          <Button
            disabled={Object.keys(dimensions).length < DIMENSIONS.length}
            onClick={() => void commit(verdict, reasons, dimensions)}
          >
            Save and continue
          </Button>
        </div>
      )}
    </div>
  );
}
