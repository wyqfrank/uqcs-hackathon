"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
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
  type Split,
  type Verdict,
} from "@/lib/labelling/types";

type Stage = "verdict" | "reasons" | "dimensions";

const VERDICT_KEYS: Record<string, Verdict> = {
  a: "a", arrowleft: "a",
  b: "b", arrowright: "b",
  t: "close",
  x: "unjudgeable",
};

/** Dimensions reuse the verdict keys, so there is one set of muscle memory. */
const DIMENSION_KEYS: Record<string, DimensionAnswer> = {
  a: "a", arrowleft: "a",
  b: "b", arrowright: "b",
  e: "equal",
  x: "unjudgeable",
};

const DIMENSION_OPTIONS: { value: DimensionAnswer; label: string; hint: string }[] = [
  { value: "a", label: "A", hint: "A" },
  { value: "b", label: "B", hint: "B" },
  { value: "equal", label: "Equal", hint: "E" },
  { value: "unjudgeable", label: "Cannot judge", hint: "X" },
];

export function LabelStation({
  rater,
  images,
  pairs,
  alreadyDone,
  splits = null,
}: {
  rater: Rater;
  images: PoolImage[];
  pairs: Pair[];
  alreadyDone: string[];
  /** Non-null when the rater was pointed at a subset via `?splits=`. */
  splits?: Split[] | null;
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
  const [dimensionIndex, setDimensionIndex] = useState(0);
  // Count only decisions inside the served subset. `alreadyDone` covers every
  // pair this rater has ever answered, so using its raw length would show a
  // rater opening `?splits=test` as already part-way through.
  const doneInScope = useMemo(() => {
    const served = new Set(pairs.map((pair) => pair.id));
    return alreadyDone.filter((id) => served.has(id)).length;
  }, [pairs, alreadyDone]);
  const [saved, setSaved] = useState(doneInScope);
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
    setDimensionIndex(0);
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

  const answerDimension = useCallback(
    (answer: DimensionAnswer) => {
      if (!pair || !verdict) return;
      const dimension = DIMENSIONS[dimensionIndex];
      const next = { ...dimensions, [dimension]: answer };
      setDimensions(next);
      if (dimensionIndex < DIMENSIONS.length - 1) setDimensionIndex(dimensionIndex + 1);
      else void commit(verdict, reasons, next);
    },
    [pair, verdict, dimensionIndex, dimensions, reasons, commit],
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
        return;
      }
      if (stage === "dimensions") {
        const answer = DIMENSION_KEYS[key];
        if (answer) { event.preventDefault(); answerDimension(answer); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, chooseVerdict, finishReasons, answerDimension]);

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
        {/* Every decision POSTs as it is made, so leaving mid-session loses
            nothing and the exit needs no confirmation. */}
        <Link href="/" className="label-exit" aria-label="Back to FITTED">
          <ArrowLeft aria-hidden="true" /> BACK
        </Link>
        <span>
          {rater.id} · {rater.cohort}
          {splits ? ` · ${splits.join(" + ")}` : ""}
        </span>
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
          <p>
            <span className="label-step">{dimensionIndex + 1} / {DIMENSIONS.length}</span>
            Which is stronger on <strong>{DIMENSIONS[dimensionIndex].toLowerCase()}</strong>?
          </p>
          <div className="label-tags">
            {DIMENSION_OPTIONS.map((option) => (
              <Button
                key={option.value}
                variant={option.value === "a" || option.value === "b" ? "default" : "outline"}
                onClick={() => answerDimension(option.value)}
              >
                {option.label} <kbd>{option.hint}</kbd>
              </Button>
            ))}
          </div>
          <div className="label-dots" aria-hidden="true">
            {DIMENSIONS.map((dimension, i) => (
              <i key={dimension} className={i < dimensionIndex ? "is-done" : i === dimensionIndex ? "is-now" : ""} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
