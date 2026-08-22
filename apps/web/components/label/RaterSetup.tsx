"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Rater } from "@/lib/labelling/types";

/**
 * Cohort and fashion-engagement capture. The PRD requires retaining this so the
 * team can measure whether parts of the target audience disagree.
 */
export function RaterSetup({ onStart }: { onStart: (rater: Rater) => void }) {
  const [id, setId] = useState("");
  const [cohort, setCohort] = useState("");
  const [engagement, setEngagement] = useState(3);

  const ready = id.trim().length > 0 && cohort.trim().length > 0;

  return (
    <form
      className="label-setup"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onStart({ id: id.trim(), cohort: cohort.trim(), engagement });
      }}
    >
      <h1>Outfit rating station</h1>
      <p>
        You will see two outfits at a time. Judge the clothing, coordination and fit —
        not the person, the photo quality or the brand.
      </p>

      <label htmlFor="rater-id">Your name or initials</label>
      <Input id="rater-id" value={id} onChange={(e) => setId(e.target.value)} autoFocus />

      <label htmlFor="rater-cohort">Cohort</label>
      <Input
        id="rater-cohort"
        value={cohort}
        onChange={(e) => setCohort(e.target.value)}
        placeholder="e.g. uq-student, designer, general"
      />

      <label htmlFor="rater-engagement">
        How closely do you follow fashion? <span>{engagement} / 5</span>
      </label>
      <input
        id="rater-engagement"
        type="range"
        min={1}
        max={5}
        step={1}
        value={engagement}
        onChange={(e) => setEngagement(Number(e.target.value))}
      />

      <Button type="submit" disabled={!ready}>Start rating</Button>
    </form>
  );
}
