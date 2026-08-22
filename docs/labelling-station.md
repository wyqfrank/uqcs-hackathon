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

Drop photos into `apps/web/public/label-pool/`. Both the pool and the collected
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

| Group | Share | Construction | Purpose |
|---|---|---|---|
| `clear` | 20% | different tiers | validates the rater understands the task |
| `close` | 55% | same tier | carries the real preference signal |
| `robustness` | 25% | same tier, different subject | exposes person/background bias |

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

| Key | Action |
|---|---|
| `A` / `←` | A wins |
| `B` / `→` | B wins |
| `T` | Too close |
| `X` | Cannot judge |
| `1`–`6` | toggle a reason tag (max two) |
| `↵` | confirm reasons and continue |

The next two pairs are preloaded, and writes are fire-and-forget, so advancing
never waits on the network or disk. Progress is saved per decision — closing the
tab loses nothing, and reopening resumes past what that rater already answered.

## Output

Decisions append to `data/labelling/decisions.jsonl`, one JSON object per line.

Label interpretation follows the PRD: `A wins` → `1.0`, `B wins` → `0.0`,
`Too close` → `0.5`, `Cannot judge` → `null`. Rows with a `null` target are
excluded from preference training and exported separately as frame-quality
examples.

Each row also retains rater id, cohort, self-reported fashion engagement, pair
group, split, and decision latency, so the team can measure whether parts of the
target audience disagree and spot rushed labels.

Export:

- `GET /api/label/export` — JSON with counts, preference rows and frame-quality rows
- `GET /api/label/export?format=csv` — flat CSV for training

## What this tool does not do

- No active learning yet. The PRD calls for progressing from random coverage to
  prioritising pairs where experts disagree or the model sits near 50/50;
  pair selection is currently random within each group.
- No multi-annotator scheduling. Important validation and test pairs should
  receive multiple independent judgements; today that means running several
  raters over the same seed and comparing.
- No image ingestion or face blurring. Curate the pool before dropping it in.
