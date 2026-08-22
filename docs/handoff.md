# FITTED scoring — handoff

Working notes for continuing the ML scoring work in a fresh session.
Last updated 2026-08-22. Product scope lives in [`PRD.md`](PRD.md); this file
records state, measurements, and the traps that cost time.

---

## Where things stand

The live battle still shows a **seeded fake** score labelled `LIVE ESTIMATE`
(`apps/web/lib/scoring.ts`). Finalisation already runs the real Gemini assessor.
The intended architecture is settled:

- **Gemini VLM → final score.** Runs once at finalisation. Built and working.
- **Trained ranker → live score.** ~1 comparison/second during the battle.
  Trained and measured, **not yet wired to the app**.

The ranker exists, works, and is clearly worse than a human. The question of what
to do next is open; the options are ranked at the bottom.

---

## The numbers that matter

All on the same **62 held-out test pairs** that both AC and DP judged decisively
(`benchmark_judges.py`):

| Judge | Accuracy | 95% CI |
|---|---|---|
| AC predicting DP (practical ceiling) | 0.871 | [0.766, 0.933] |
| **Gemini** | **0.758** | [0.676, 0.825] |
| Our ranker | 0.645 | [0.558, 0.724] |

On the 54 pairs where both raters agreed (humans 1.000 by definition):
Gemini **0.796**, ranker **0.667**.

**Student–teacher agreement: 0.661.** The ranker reproduces two-thirds of
Gemini's decisions. This is the number that controls live-vs-final leader flips:
at 0.661, roughly **one battle in three would show a live leader who loses at the
reveal**. That is a product risk, not just an accuracy statistic.

### Inter-rater agreement

| Pair | Agreement | n |
|---|---|---|
| AC–DP | 0.778 | 419 |
| DP–FW | 0.563 | 135 |
| AC–FW | 0.491 | 114 |

FW is not careless — their median decision took 4.9 s, the slowest of the three.
Their taste is simply uncorrelated with the other two. This is the empirical
basis for defining a cohort rather than pooling raters.

### Capacity sweep (2026-08-22, hypothesis rejected)

Fitting the student on 1,972 Fashion144k teacher labels, varying only how many
embedding dimensions it keeps:

| dims | Fit to Gemini | Zero-shot val | Fine-tuned val |
|---|---|---|---|
| 16 (shipped) | 0.674 | 0.709 | 0.734 |
| 32 | 0.681 | 0.709 | 0.728 |
| 64 | 0.696 | 0.715 | 0.741 |
| 128 | 0.695 | 0.703 | 0.741 |
| 384 (no compression) | 0.695 | 0.703 | 0.741 |

**Capacity is not the bottleneck.** With zero compression the student still only
reproduces Gemini at 0.695. The plateau is the ceiling of a *linear* function of
DINOv2 embeddings; more dimensions cannot cross it.

dims=64 is a genuine but tiny improvement in teacher fidelity (0.674 → 0.696, and
at n=1926 that is outside noise). It is **not** currently adopted — the shipped
artifact is dims=16 to match what the PRD documents. Adopting 64 is free.

---

## Shipped configuration

```bash
python services/inference/scripts/train_ranker.py \
  --dims 16 --raters AC,DP --projection train \
  --teacher data/labelling/teacher.jsonl --report-test
```

Artifact: `models/ranker/ranker.npz` + `ranker.json` (gitignored — `models/` is
ignored, so the artifact must be regenerated after a fresh clone).

Architecture: frozen DINOv2-S → PCA to 16 dims (basis fitted on training images
only) → linear pairwise scorer, **no intercept**, so swap consistency holds by
construction rather than by measurement.

---

## Scripts

All training-only, in `services/inference/scripts/`, outside the deployable
wheel (which packages `src/fitted_inference` only).

| Script | Purpose |
|---|---|
| `train_ranker.py` | Embed, project, train, evaluate, save the artifact |
| `distil_teacher.py` | Collect Gemini teacher labels over an image pool |
| `prepare_teacher_pool.py` | Stream Fashion144k → webcam-like WebP pool |
| `benchmark_judges.py` | Score human / Gemini / ranker on identical pairs |

Useful `train_ranker.py` flags: `--dims`, `--raters AC,DP`, `--decisions-dir`
(frozen snapshot), `--teacher`, `--projection {train,teacher}`, `--tie-margin`,
`--report-test`.

---

## Data assets

| Asset | State |
|---|---|
| `apps/web/public/label-pool/` | 183 images, **gitignored**. Fingerprint `5c66110ab00b93df` |
| `data/labelling/decisions.{ac,dp,fw}.jsonl` | 486 / 600 / 177 decisions, committed |
| `data/labelling/teacher.jsonl` | 1,972 Gemini pairs over Fashion144k, committed |
| `models/ranker/judge-benchmark.jsonl` | 62 Gemini judgements on **test** pairs |
| `data/teacher-pool/` | 25,000 prepared WebP images, gitignored |
| `data/fashion144k/` | 7.8 GB source archive, gitignored |

Only ~2,001 of the 25,000 prepared images were used (2,000 pairs × 2, each image
appearing about twice). The rest are ready if a larger teacher run is wanted.

Approximate spend so far: **~$5** across ~2,034 Gemini calls.

---

## Traps that cost time — read before touching this

1. **`pairId` sorts its two ids** (`apps/web/lib/labelling/pairing.ts:58`), so
   canonical left/right is *not* recoverable from it. Always use
   `shownLeftId`/`shownRightId` with `shownVerdict`. Getting this backwards
   silently inverts every label.
2. **The label pool is gitignored and does not survive a clone.** Re-ingest the
   original export and confirm the fingerprint matches `5c66110ab00b93df`, or
   every collected decision is orphaned (ids are hashed from filenames).
3. **`.env` is only loaded by `scripts/dev.mjs`.** Standalone Python scripts need
   their own loader — `distil_teacher.load_dotenv` does this, **last assignment
   wins**, matching Node. An earlier first-wins version disagreed with the
   service about duplicated variables.
4. **Raters label continuously.** Two runs minutes apart get scored on different
   validation sets. Always compare configurations against a frozen snapshot via
   `--decisions-dir`.
5. **Every HTTP 429 is classified as `VlmProviderQuotaError`** in `vlm.py`. Right
   for the live path; for a bulk job a transient rate-limit aborts the whole run.
   The runs are resumable, so the fix is to re-run, not to investigate.
6. **Fashion144k is licensed non-commercial** ("research and educational purposes
   only"). A model distilled from it cannot ship commercially. Training the
   student on Gemini's judgements of *our own* photos would remove this
   constraint entirely.
7. **Teacher settings must mirror production.** `distil_teacher.py` reads
   `FITTED_VLM_MODEL`, `FITTED_VLM_PROMPT_VERSION`, `FITTED_VLM_MEDIA_RESOLUTION`
   from the environment. A teacher judging under different settings is a
   different judge. Note `.env` sets prompt `v1` while the code default is `v2`.

---

## Test-set hygiene — important

The test split has now been read **five times**: single-rater Plan A, pooled
three-rater, AC+DP distilled, AC+DP human-only, and the judge benchmark. Each
read costs a little of its independence.

Treat the current test numbers as reliable but do not keep tuning against them.
Further configuration choices should be made on validation. If a genuinely clean
number is needed later, collect fresh labels or hold out new images.

---

## Decisions made, and why

- **Cohort, not population.** Shipped model trains and evaluates on AC+DP only.
  Pooling all three raters gives a test result indistinguishable from chance
  (0.553, CI [0.485, 0.619]). **Caveat: the cohort was chosen after seeing the
  agreement matrix** — a post-hoc selection. The defensible claim is "predicts
  the AC+DP cohort", not "predicts good taste".
- **Fashion144k votes discarded.** They measure engagement (photo quality, fan
  count, posting era), which is the confound the descoped residual experts
  existed to remove. Only pixels were used.
- **`--projection train`.** Fitting the PCA basis on Fashion144k images is worse
  in every configuration (0.613 vs 0.660 pooled). The teacher's *judgements*
  cross the domain gap; its *image statistics* do not.
- **Distillation kept despite not improving accuracy** (0.643 vs 0.636
  human-only, same 140 pairs). Its value is label independence: the zero-shot
  student scores 0.709 against a human-trained 0.715, so retargeting a new cohort
  no longer requires collecting preference data first.

---

## Open options, ranked

**1. Non-linear head — free, ~10 min.** The capacity sweep implies the wall is
linearity, not size. Replace the weighted sum with a small MLP; same data, same
embeddings, different function class. This is the direct test and costs nothing.

**2. In-domain teacher labels — ~$5, ~1 hour.** Have Gemini judge pairs built
from the project's own 128 **training-split** images instead of Fashion144k.
Removes the domain gap and removes the non-commercial licence constraint.
**Critical: pair only train-split images.** The 62 benchmark pairs are test pairs
and must never enter training. 128 train images give 8,128 possible pairs, so
supply is not a limit.

**3. Different encoder — free-ish, ~15 min.** SigLIP 2 or FashionCLIP, both still
open questions in the PRD and never benchmarked. If DINOv2's features do not
encode what Gemini reacts to, no head shape or training data fixes it.

**4. Wire to the app.** Replaces a seeded fake with something real. Needs: load
the artifact in `src/fitted_inference`, add DINOv2 embedding to the live path
(**71 ms/frame measured on this CPU**), calibrate `w·z` to a 0–100 display score,
replace the client's seeded estimate.

### Before anything reaches the app

**Nobody has ever run this model on a real webcam frame.** It was trained
entirely on curated full-body photos; live input is a 640 px webcam crop under
venue lighting. Check that scores are stable across frames of one outfit and
correctly order two visibly different outfits. If that fails, wiring it up merely
substitutes a differently fake number.

Also consider presenting the live score as a range or "leaning" rather than a
hard leader. At 0.661 student–teacher agreement the live leader contradicts the
reveal about a third of the time, and a live bar that crowns nobody cannot be
contradicted. The PRD already leans this way.

### Not worth revisiting

More PCA dimensions (measured, flat), more Fashion144k teacher pairs (zero-shot
already matches a human-trained model), and Fashion144k's own vote labels.

---

## Ceilings

The student copies Gemini, so **it cannot exceed Gemini's 0.758** on this cohort.
Gemini in turn sits below the human ceiling of 0.871. Improving the *fast path*
is not the same as improving the *judging*, and the realistic target for the
ranker is somewhere in the mid-0.70s.
