# Outfit rating station

An internal tool for collecting the pairwise A/B outfit preferences that
calibrate the FITTED scoring model. It implements
[`docs/PRD.md` § Target-audience pair comparisons](PRD.md).

Route: **`/label`** in `apps/web`. It is local tooling, not part of the product
flow, and is not linked from the battle UI.

## Running it

```bash
npm run dev:web        # or npm run dev for web + inference
```

Then open <http://localhost:3000/label>.

## Preparing the image pool

For a flat folder of photos (the common case — e.g. a Drive export), run:

```bash
node scripts/ingest-label-pool.mjs ~/Downloads/outfit-photos --clear
node scripts/ingest-label-pool.mjs ~/Downloads/outfit-photos --dry-run   # preview
```

A flat dump carries no grouping information, so **every photo becomes its own
subject**. That is correct when each photo shows a different person in a
different outfit. If several photos share a person or outfit, name them with a
shared prefix (`alice-01.jpg`, `alice-02.jpg`) and pass `--group-by-prefix`, so
those frames stay in one split and are never paired against each other.

Subject ids are hashed from the filename, so re-running after adding photos
keeps existing ids — and therefore existing split assignments and already
collected decisions — stable.

Alternatively, drop photos into `apps/web/public/label-pool/` by hand. Both the pool and the collected
decisions are gitignored — this is local data, not repository content.

**Filenames carry the metadata**, so curating the pool is a rename rather than a
spreadsheet:

```
<subject>__<tier>__<note>.jpg
s01__high__front.jpg
s01__high__side.jpg
s02__low__front.jpg
```

- `subject` — one person/outfit/session. Every image sharing a subject stays in
  the same train/val/test split, so an image and an adjacent frame of the same
  outfit can never straddle a boundary.
- `tier` — `high` / `mid` / `low`. A curator hint used **only** to build pair
  groups. It is never shown to raters and is not a training label.
- `note` — free text, ignored.

Missing parts degrade gracefully; the file still enters the pool.

Target roughly **200–400 unique images** to support the planned
**500–1,000 decisions**, per the PRD. Follow the PRD's image guidance: full body
including shoes, mostly front-facing, one person, consistent crop, clear
lighting, faces blurred or excluded, and no likes, prices, brands or captions.

## How pairs are built

`lib/labelling/pairing.ts` constructs the PRD's three groups deterministically
from a seed, so every rater sees the same pair ids and inter-rater agreement is
measurable:

| Group | Weight | Requires | Construction | Purpose |
|---|---|---|---|---|
| `clear` | 0.20 | `tier` on images | different tiers | validates the rater understands the task |
| `close` | 0.55 | nothing | same tier (or both untiered) | carries the real preference signal |
| `robustness` | 0.25 | shared `outfitTag` | same tag, different subject | exposes person/background bias |

**Groups are gated on the metadata that actually exists.** A group is omitted
rather than faked: labelling a pair `robustness` when it was built exactly like
a `close` pair would put meaningless group metadata into the training set. The
remaining groups absorb the quota.

A flat, untagged pool therefore yields **`close` pairs only** — which is the
honest outcome, since neither an obvious quality gap nor outfit similarity can
be inferred from the files. To unlock the other two groups, add a `tier`
(`high`/`mid`/`low`) and/or an `outfitTag` to the filenames:
`<subject>__<tier>__<note>.jpg`.

A pair never repeats, never pairs an image with itself or another image of the
same subject, and never crosses a split boundary.

**Left/right placement is mirrored per rater**, seeded on `(pairId, raterId)`.
The same rater reloading sees a stable arrangement; different raters see the
pair from both sides. Decisions are stored both as shown and normalised back to
canonical order.

Reason tags are collected on ~35% of pairs and dimension judgements on ~25%,
matching the PRD's 20–30% guidance, so the primary task stays fast.

## Rating

Keyboard-first, because throughput is the point:

| Stage | Key | Action |
|---|---|---|
| Verdict | `A` / `←` | A wins |
| Verdict | `B` / `→` | B wins |
| Verdict | `T` | Too close |
| Verdict | `X` | Cannot judge |
| Reasons | `1`–`6` | toggle a reason tag (max two) |
| Reasons | `↵` | confirm and continue |
| Dimensions | `A` / `←` | A stronger |
| Dimensions | `B` / `→` | B stronger |
| Dimensions | `E` | Equal |
| Dimensions | `X` | Cannot judge |

Dimension judgements are asked **one at a time** and reuse the same `A`/`B`
keys as the verdict, so there is a single set of muscle memory. Answering
advances to the next dimension; the third answer saves and moves on. Three
keystrokes, no mouse, and the photos stay large while being judged.

The next two pairs are preloaded, and writes are fire-and-forget, so advancing
never waits on the network or disk. Progress is saved per decision — closing the
tab loses nothing, and reopening resumes past what that rater already answered.

## Output

**One file per rater**: `data/labelling/decisions.<rater>.jsonl`, one JSON
object per line. Each person labels the full set independently and the results
are aggregated afterwards, so there are no interleaved writes and per-rater
agreement stays measurable.

For the aggregate to be meaningful, every rater must see the **same pairs** —
that means the same image pool and the same seed. Either run one server that
everyone opens over the LAN, or make sure each machine ingests the identical
photo set (subject ids are hashed from filenames, so identical files give
identical ids).

Label interpretation follows the PRD: `A wins` → `1.0`, `B wins` → `0.0`,
`Too close` → `0.5`, `Cannot judge` → `null`. Rows with a `null` target are
excluded from preference training and exported separately as frame-quality
examples.

Each row also retains rater id, cohort, self-reported fashion engagement, pair
group, split, and decision latency, so the team can measure whether parts of the
target audience disagree and spot rushed labels.

Export:

- `GET /api/label/export` — JSON: summary, per-pair consensus, preference rows, frame-quality rows
- `GET /api/label/export?format=csv` — raw per-decision CSV (one row per rater per pair)
- `GET /api/label/export?format=consensus` — **one row per pair**: the aggregated
  soft label to train against

### Getting the photos to other raters

The pool is gitignored, so a teammate who clones the repo has code but no
images. Pick one of these.

**1. One machine over the LAN (recommended).** The rater with the pool runs the
server; everyone else opens `http://<their-ip>:3000/label`. No pool to
distribute, no way for it to diverge, and all three `decisions.<rater>.jsonl`
files land in one `data/labelling/` ready to export. Costs: everyone rates at
the same time, and that machine has to stay up.

**2. Share the source photos and re-ingest.** Send the identical zip (or point
everyone at the same Drive folder), then each rater runs:

```bash
node scripts/ingest-label-pool.mjs ~/Downloads/outfit-photos --clear
node scripts/ingest-label-pool.mjs --fingerprint
```

**Compare fingerprints before anyone starts rating.** Pair ids are derived from
image filenames, so a pool that differs by even one renamed file produces ids
nobody else has:

```
pool fingerprint: 5c66110ab00b93df     <- all raters must match
images: 183
```

A re-download that yields `IMG_3670 (1).JPG` instead of `IMG_3670.JPG` keeps
the same file count and changes the fingerprint. Checking takes a second;
discovering the mismatch after labelling costs an hour of work per rater.
`scripts/merge-labels.mjs` catches it too, but only afterwards.

**3. Commit the pool.** Guarantees a byte-identical set for everyone. Before
doing it, consider that these are scraped photos of identifiable people, some
with creator handles visible, and a git commit is permanent and public if the
repository is.

### Merging files from separate machines

If each rater ran the app on their own laptop, collect their
`data/labelling/decisions.<rater>.jsonl` files and merge them:

```bash
node scripts/merge-labels.mjs ~/Downloads/decisions.angus.jsonl ~/Downloads/decisions.frank.jsonl
node scripts/merge-labels.mjs ~/Downloads/labels/        # or a whole folder
node scripts/merge-labels.mjs ... --dry-run              # preview
```

Rows are grouped by the rater id **recorded inside them**, not by filename, and
a rater labelling the same pair twice keeps their latest answer. Existing files
in `data/labelling/` are folded in, so re-running is safe.

The script then checks whether the merge is actually comparable:

```
raters: 3   distinct pairs: 137   labelled by all: 0
  angus             60 pairs   100% shared
  dp                97 pairs    62% shared
  frank             40 pairs     0% shared   <-- POOL MISMATCH
```

**This is the failure worth guarding against.** Pair ids are derived from image
filenames, so a rater who ingested a different photo set produces ids nobody
else has. The merge succeeds, the totals look healthy, and there is nothing to
compare — silently. The same report is available from
`GET /api/label/export` under `merge`.

Not every pair needs every rater. Partial overlap is fine and normal: only the
shared pairs contribute to agreement, while the rest still carry single-rater
targets.

### Aggregation

`lib/labelling/aggregate.ts` combines the independent passes:

- **`meanTarget`** — the soft training label. Three raters split 2–1 gives
  `0.67` rather than a forced winner, so genuine disagreement reaches the model
  as uncertainty instead of noise.
- **`agreement`** — share of raters giving the modal verdict. `1.0` is unanimous.
- **`contested`** — true when raters disagreed on *who won* (ignoring
  `Too close` / `Cannot judge`).
- **`meanAgreement`** across shared pairs is the practical estimate of the
  model's realistic ceiling: no model should be expected to beat the rate at
  which humans agree with each other.

`Cannot judge` votes are counted but excluded from `meanTarget`. A pair nobody
could judge gets a `null` target and is exported as a frame-quality example.

## What this tool does not do

- No active learning yet. The PRD calls for progressing from random coverage to
  prioritising pairs where experts disagree or the model sits near 50/50;
  pair selection is currently random within each group.
- No multi-annotator scheduling. Important validation and test pairs should
  receive multiple independent judgements; today that means running several
  raters over the same seed and comparing.
- No image ingestion or face blurring. Curate the pool before dropping it in.
