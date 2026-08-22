# FITTED — Product Requirements Document

## 1. Overview

**Working name:** FITTED  
**Status:** Hackathon prototype  
**Document status:** Draft — unresolved decisions are marked **TBD**

FITTED is a live fashion battle where two people connect through their cameras and an ML system compares their outfits.

The prototype should answer one central question: can an ML model act as a fun, fast referee for a live outfit comparison?

---

## Delivery Status

This checklist is the high-level source of truth for specification and implementation progress.

- `[ ]` means incomplete, undecided, or not yet verified.
- `[x]` means the stated outcome is complete and has been verified.
- Describing or proposing an item elsewhere in this PRD does not make it complete.
- Update the relevant checkbox in the same change that completes the work.

### Specification status

- [x] Core two-player product flow is defined.
- [x] Current landing and battle-room UI direction is documented.
- [x] Social weak supervision plus target-audience A/B calibration is documented as the current ML direction.
- [ ] Target audience is defined precisely enough to recruit representative judges.
- [x] Initial CV detection specification is documented in [`docs/specs/cv-detection.md`](specs/cv-detection.md).
- [x] Provisional live-score ranges and authoritative final-score behaviour are documented in [`docs/specs/scoring-spec.md`](specs/scoring-spec.md).
- [ ] CV detection, frame-quality, and canonical-cropping specification is finalised and validated.
- [ ] Instagram and Depop data-acquisition and residual-construction specification is finalised.
- [ ] Final scoring, calibration, draw, and displayed-score behaviour is decided.
- [x] Hackathon inference ownership and frame transport are decided.
- [ ] Deployment architecture is decided.

### Implementation status

- [x] The repository separates the web/signalling workspace from an installable Python inference-service package with a health endpoint and typed comparison boundary.
- [x] Landing page supports creating and joining a room with room-code validation.
- [x] Socket.IO room creation, joining, capacity limits, SDP relay, leaving, and reconnection pass the signalling smoke test.
- [x] Local camera lifecycle and camera error states are implemented.
- [x] WebRTC local and remote video-feed handling is implemented.
- [ ] The complete two-laptop flow is verified on the intended HTTPS demo environment.
- [x] Video-frame capture and latest-frame backpressure are implemented.
- [x] Battle UI supports framing readiness, finalisation states, authoritative
      results, copying the room code, and leaving without fabricated scores.
- [x] Person/pose detection and frame-quality gating are implemented.
- [x] Canonical padded outfit cropping is implemented, with feet treated as optional evidence.
- [x] A typed server-side garment-perception API and Grounding DINO baseline adapter are implemented and smoke-tested on one full-body image.
- [x] Grounding DINO is rejected as the live garment runtime after a measured approximately 10.6-second CPU inference.
- [x] RF-DETR-Seg Small is selected as the only time-boxed live garment-perception candidate, with an explicit pass/fail gate.
- [x] The RF-DETR adapter, batched garment API, server-owned 1 FPS zero-queue
      transport, finalisation pause, and category-chip UI are implemented and covered
      by automated tests.
- [ ] RF-DETR-Seg meets the live latency and correctness gate on representative webcam crops from the intended demo hardware.
- [ ] Passing garment perception updates the live battle at approximately 1 FPS with one inference operation in flight and no queued frames.
- [ ] A frozen visual-encoder baseline is implemented and evaluated.
- [ ] A pairwise scoring head is implemented and evaluated.
- [ ] The live battle displays labelled provisional score ranges from the fast
      scoring path. Not implemented: no range, `Live estimate` or `Provisional`
      treatment exists in the battle UI yet.
- [x] Battle finalisation runs the configured VLM path, broadcasts exact scores
      and the winner or draw to both players, and locks the result against late work.
- [ ] Live-to-final range coverage, score error, leader reversals, and transition behaviour are verified on representative webcam battles.
- [ ] Instagram residual labels and expert model are implemented.
- [ ] Depop residual labels and expert model are implemented.
- [ ] Target-audience A/B labelling dataset is collected.
- [x] A real inference backend is implemented: the service exposes a Gemini VLM
      scoring provider behind a typed engine boundary, gated on the package's
      `vlm` extra and a configured API key. It reports `ready` only when a
      provider is configured and raises rather than inventing a score.
- [x] The placeholder score generator is removed; pre-finalisation UI shows
      framing/readiness rather than invented numeric scores.
- [ ] The live (pre-finalisation) path produces model-derived scores. It currently
      runs garment perception only; live numeric scoring is not implemented.

### Verification status

Last verified against the working tree on 2026-08-22.

- [x] TypeScript typecheck passes (`npm run typecheck`).
- [x] Production build passes (`npm run build`).
- [x] Signalling smoke test passes (`npm run test:signaling`) — create, join,
      capacity, SDP relay, and reconnect.
- [x] Web unit tests pass: 23 tests across 7 files covering scoring, garment
      perception, frame capture, and the CV modules.
- [ ] Python inference tests run in the standard dev environment. Currently
      blocked: `test_api.py`, `test_rfdetr_perception.py` and `test_vlm_engine.py`
      import `PIL` unconditionally, but `pillow` is declared only in the `ml`,
      `rf` and `vlm` extras — not in `dev`. `npm run test:api` fails at collection
      on a dev-only install.
- [ ] `npm run test:web` succeeds through the npm workspace wrapper. The
      `test:unit` script passes an unquoted `--exclude scripts/**` glob, which the
      shell expands before vitest sees it; running vitest directly passes.
- [ ] Real webcam, motion, detection, scoring, and two-device behaviour are verified together.

---

## 2. Product Goal

Create a reliable two-player experience in which:

1. one player creates a battle;
2. a second player joins from another device;
3. both players can see each other's live camera feed;
4. the system analyses both outfits; and
5. the UI presents a comparison quickly enough to feel interactive.

The exact meaning and presentation of the comparison are still **TBD**.

---

## 3. Target Experience

```text
Player A creates a battle
          ↓
Player B joins with the room code
          ↓
Both players grant camera access
          ↓
Both live feeds connect
          ↓
The ML system analyses both outfits
          ↓
A comparison result is shown
```

### Experience principles

- Fast to start.
- Clearly communicate camera, connection, opponent, and analysis states.
- Keep the video experience smooth while analysis runs separately.
- Make the result easy to understand at a glance.
- Treat the comparison as entertainment, not an objective judgement of a person.

---

## 4. MVP Requirements

### Required

- Create a two-player battle room.
- Join a battle using a room code.
- Connect two separate laptops or devices.
- Request and display each player's webcam feed.
- Show both live feeds in the battle room.
- Capture frames for ML inference without interrupting video playback.
- Pass outfit imagery through an ML inference boundary.
- Receive an outfit comparison result.
- Display the result and relevant loading, error, and connection states.
- Support leaving a battle and handling a disconnected opponent.

### Nice to have

**TBD — prioritise after the core two-player flow and ML approach have been validated.**

Questions to resolve before adding items here:

- Which additions make the battle meaningfully more fun or repeatable?
- Which additions improve demo reliability or make the ML result clearer?
- What can be completed without risking the required flow?

---

## 5. User Interface

**The UI is finalised for the hackathon.** The street/arcade visual system
described below is the shipped design; no further redesign is planned. Changes
from here should be corrective (legibility, overlap, responsive behaviour) rather
than directional.

### Visual system

- Urban street meets arcade cabinet: near-black concrete grounds (`#0b0b0b`
  ink, `#131313` shell, `#1e1e1e` panels) under hazard stripes and a halftone
  dot grid.
- Two type voices: a hand-tagged graffiti display face (GraffitiXenoa, vendored
  at `apps/web/app/fonts/`) for headlines and player names, and VT323 for every
  piece of UI text. VT323 is a pixel face and is not set below 16px.
- Player accents are fixed and semantic: **P1 electric magenta** (`#ff2ec4`),
  **P2 acid green** (`#b6ff1f`), with **hot orange** (`#ff6a00`) reserved for
  system/primary actions. A player's accent drives their panel bevel, number
  block, corner brackets, score plate and meter from a single token.
- Chunky bevelled controls with hard (unblurred) drop shadows and a real
  pressed state; a consistent `-9deg` skew on panels and controls.
- Camera feeds occupy roughly 60–65% of viewport height and stretch to fill
  available space. They carry no filter or scanline overlay.

### Landing screen

- FITTED branding and short explanation of the battle.
- **Create Battle** action.
- **Join Battle** action.
- Room-code entry and validation.

### Battle room

- Symmetrical local and opponent video panels, separated by a hairline seam with
  the VS badge straddling it.
- Player labels (`P1`/`P2` number blocks), room code, and copy affordance.
- Camera and peer-connection status, including ICE transport diagnostics
  (`STUN OK`, `TURN OK`, `NO ROUTE TO OPPONENT`, `NO VIDEO ROUTE`).
- Waiting, connecting, analysing, disconnected, and error states — drawn from a
  single shared vocabulary, never ad-hoc strings.
- Per-feed score HUD: an arcade `1UP`/`2UP` label and value set directly on the
  video over a gradient scrim, with a full-bleed segmented meter flush to the
  bottom edge at a 26px segment pitch. It is an overlay, not a card.
- Garment category chips derived from live perception.
- Outfit-detection overlay showing the canonical crop and pose landmarks.
- Controls for camera, copying the room code, **finalising** the score, retrying
  a failed final score, and leaving.

Canonical control and state labels currently shipped: `START CAMERA` /
`STOP CAMERA`, `FINALISE SCORE`, `RETRY SCORE`, `COPY CODE` / `COPIED`, `LEAVE`,
`STANDBY`, `LIVE`, `CAPTURING FITS`, `CAPTURING BOTH FITS`,
`ANALYSING FINAL RESULT`, `SCORE FINAL`, `TOO CLOSE TO CALL`,
`WAITING FOR OPPONENT`, `OPPONENT CONNECTED`, `OPPONENT CAMERA OFF`,
`LOCAL ONLY`, `SIGNAL LOST`, `CONNECTION LOST`, `NO BATTLE FOUND`.

### Result experience

The hackathon product uses **both** a lightweight live estimate and a more
accurate final result. They must be visually and semantically distinct.

During the battle, each player sees a smoothed integer score range such as
`72–82`, persistently labelled **Live estimate** or **Provisional**. The interface
may say who is currently ahead or that the battle is too close to call, but it
must not declare a winner. The fast path starts at approximately one comparison
per second, holds the last valid range when work is skipped, and does not block
the video experience.

The initial range is the smoothed live estimate plus or minus five points. Tune
that width against the final scorer so at least 80% of representative per-player
final scores land inside the last live range. The full range may be widened from
ten to at most sixteen points. If useful coverage still requires a wider range,
remove the live numbers and retain only a qualitative current-leader treatment.
Do not imply that the range is a calibrated confidence interval.

When the battle is frozen or ended, both clients enter **Analysing final result**.
The server scores the best fresh synchronised pair, or a verified short burst,
using the most accurate configured path. It then broadcasts exact one-decimal
scores and the final winner or draw to both clients and locks the result. Late
live responses cannot change it.

The accurate final score is not clamped to the previous live range. An
out-of-range result is revealed truthfully, described as an adjusted estimate,
and recorded for calibration. If final analysis fails or the images cannot be
judged, the product keeps the prior value labelled as an estimate, offers a
retry, and does not turn it into a final winner.

The detailed smoothing defaults, response states, continuity targets, and
implementation checklist live in
[`docs/specs/scoring-spec.md`](specs/scoring-spec.md).

**Still TBD:**

- the automatic or player-triggered battle-ending mechanic;
- the measured final draw threshold;
- how much final reasoning or calibrated confidence to show; and
- the exact retry/recapture interaction for poor framing or an outfit that is not sufficiently visible.

---

## 6. ML System

### Goal

Given images of two outfits, predict which outfit is more likely to be preferred by the defined FITTED target audience.

The model evaluates the visible outfit, not the attractiveness or value of the person wearing it. The result is an entertainment-oriented preference signal rather than an objective measure of fashion quality.

### Current design direction

Use broad social and commercial behaviour as weak supervision, then use direct A/B judgements from the target audience to calibrate the final FITTED scoring function.

```text
Instagram residual expert
          +
Depop residual expert
          +
component, coordination and body-fit signals
          +
VLM holistic assessment and explanation
          +
visual style momentum (later)
          ↓
expert ensemble
          ↓
500–1,000 target-audience pair comparisons
          ↓
pairwise FITTED scoring function
```

This is a teacher–student design:

- social and commercial data provide large-scale but noisy offline supervision;
- target-audience comparisons determine how the weak signals and VLM assessment should be combined;
- the resulting visual scoring model runs without contacting social platforms during a live battle.
- the VLM supplies a grounded breakdown and final explanation, but does not own the score by itself.

### Shared visual representation

Each training image is passed through the same frozen visual encoder. Source-specific expert heads learn different signals from that shared embedding:

```text
outfit image
     ↓
frozen visual encoder
     ↓
outfit embedding
     ├── Instagram expert → predicted relative social engagement
     ├── Depop expert → predicted relative commercial desirability
     └── momentum expert → predicted visual-style momentum
```

The first frozen-encoder experiment should benchmark **DINOv2 Small** and **SigLIP 2 Base**. DINOv2 is attractive for a lightweight learned visual ranker; SigLIP 2 also supports a prompt-based zero-shot baseline. The hackathon must not depend on full encoder fine-tuning.

**FashionCLIP** should be benchmarked as a second candidate, not assumed to be better. It is fashion-specific, but its published training domain is primarily isolated product imagery rather than webcam images of people wearing complete outfits.

The encoder remains frozen for the first implementation. Full fine-tuning should only be considered if the source experts and scoring head cannot learn a useful signal from frozen embeddings.

### Outfit composition and body-aware fit

The FIT score must evaluate both individual garments and the outfit as a complete composition. A collection of individually strong pieces should not automatically score well if their colours, proportions, silhouettes or styling do not work together.

The visual analysis should produce three distinct score groups:

1. **Component quality** — the visible styling quality of detected tops, bottoms, outerwear, shoes and accessories.
2. **Whole-outfit coordination** — how the pieces play off each other through colour harmony, silhouette, layering, proportion, material and style coherence.
3. **Body-aware fit and proportion** — how the garments sit and align on the wearer, using pose and silhouette information without judging the wearer's body type.

```text
latest outfit frame
        |
        +--> person and frame-quality check
        +--> garment detection / segmentation --> component scores
        +--> pose and silhouette estimation ----> body-fit score
        +--> full-outfit visual embedding ------> coordination score
                                                    |
                                                    v
                                           weighted FIT score
```

The body-aware branch may assess visible garment alignment, sleeve and trouser length, layering, silhouette balance and overall proportions. It must not score body shape, facial appearance, attractiveness, gender presentation or other personal characteristics. Face information is excluded from the competitive score.

Bounding-box detection is sufficient for locating initial garment components. Segmentation should be evaluated later for measurements that depend on garment boundaries, layering and silhouette.

#### Live garment perception decision

Garment-category recognition is useful to the hackathon only when it updates during the live battle. A result produced only after freezing the battle is out of scope for this branch.

The implemented Grounding DINO Tiny baseline took approximately 10.6 seconds for one image on the CPU-only development environment and is therefore rejected as the live runtime. Keep it as a diagnostic baseline only.

Time-box one replacement attempt to **90 minutes** using the Fashionpedia-trained [`resoa/garment-detector-seg`](https://huggingface.co/resoa/garment-detector-seg) RF-DETR-Seg Small checkpoint. The checkpoint model card declares its weights Apache 2.0. Before integration, pin its revision and checksum and record the model, architecture, and Fashionpedia attribution and licence notices.

The replacement passes only if it maps into the reduced FITTED taxonomy and sustains approximately one result per second on the intended demo hardware over a 15–20 crop gate set without stalling video. The client or coordinator permits one garment request in flight, discards busy ticks, and retains the latest valid boxes between updates.

If the candidate misses the latency, correctness, licensing-provenance, or 90-minute delivery gate, remove live garment categorisation from the hackathon MVP. Do not replace it with a frozen-only garment result. Whole-outfit scoring and pose/frame-quality detection continue without component detections.

#### Initial deterministic weighting

For the hackathon prototype, use deterministic weights that are easy to explain and tune:

```text
component quality        45%
whole-outfit coordination 30%
body-aware fit            25%
```

The initial component-quality weights are:

```text
top         30%
bottoms     25%
outerwear   20%
shoes       15%
accessories 10%
```

Only confidently detected and sufficiently visible components participate in the denominator. Missing optional garments, such as outerwear or accessories, must not be treated as zero-quality garments. Category-aware rules must also avoid penalising outfits such as dresses that do not contain separate tops and bottoms.

```text
component_score =
  sum(style_score_i * weight_i * detection_confidence_i * visibility_i)
  / sum(weight_i * detection_confidence_i * visibility_i)

visual_fit_score =
    0.45 * component_score
  + 0.30 * coordination_score
  + 0.25 * body_fit_score
```

These are product defaults, not claims about objective fashion importance. Once sufficient target-audience comparisons exist, the weights should be fitted against held-out human preferences with non-negative constraints and regularisation. Training may use stochastic techniques, but live inference should use deterministic learned weights so the same input does not receive a randomly different result.

The whole-outfit coordination score must be learned or evaluated from the complete outfit image rather than calculated as an average of component scores. This preserves interaction effects: two pieces can score differently together than either would in isolation.

### Source-signal construction

Raw popularity metrics must not be treated as taste labels. Each source first needs its own residual signal that removes as much non-outfit influence as the available data permits.

#### Instagram residual expert

The Instagram expert learns to predict whether an outfit post overperforms relative to its expected engagement.

```text
Instagram residual =
actual engagement
− expected engagement given
  creator, audience size, normal engagement,
  post age, format, posting time and other available context
```

Where reach is unavailable, use within-creator and within-time-period ranks rather than comparing raw likes between creators.

#### Depop residual expert

The Depop expert learns whether an item or styled listing overperforms relative to comparable listings.

```text
Depop residual =
actual demand
− expected demand given
  brand, category, price, condition,
  seller, listing age and available promotion context
```

Depop is a secondary signal because listing performance measures product demand more directly than complete-outfit preference. Its contribution should be learned from target-audience comparisons rather than fixed in advance.

#### Visual style momentum

Style momentum is a proposed later signal, not required for the first model:

1. embed images from available sources;
2. group visually similar outfits into style neighbourhoods;
3. measure changes in residual popularity for each neighbourhood over time;
4. use cross-platform acceleration as a weak trend signal.

The first experiment should start with the Instagram and Depop experts. Add momentum only after the source residuals and time alignment can be measured reliably.

### Target-audience pair comparisons

The human dataset should initially contain approximately **500–1,000 individual A/B decisions** from people representing the intended FITTED audience.

```text
Which outfit fits best?

[ Outfit A ]    [ Outfit B ]

A wins | B wins | Too close | Cannot judge
```

Label interpretation:

- **A wins** → `1.0`;
- **B wins** → `0.0`;
- **Too close** → draw or soft target of `0.5`;
- **Cannot judge** → exclude from preference training and retain as a frame-quality example.

#### Labelling workflow

Collect the overall preference before asking the judge to explain it. Showing detailed scoring categories first may anchor the judge to the prototype's weighting scheme instead of capturing their genuine overall preference.

Every comparison uses this primary question:

```text
Which outfit is better styled as a complete look?

A wins | B wins | Too close | Cannot judge
```

The overall A/B decision is the primary training target for the final pairwise weighting function. `Too close` and `Cannot judge` remain valid answers and judges must not be forced to select a winner.

After an **A wins** or **B wins** decision, comparisons selected for additional annotation ask the optional follow-up:

```text
What most influenced your choice? Select up to two.

Individual pieces | Outfit coordination | Fit and proportion
Colour | Layering | Other
```

Reason tags support explanations, dataset analysis and debugging. They must not be treated as sufficient evidence for learning numerical weights because they identify a reported reason, not its magnitude or the contribution of competing factors.

Collect direct dimension judgements on approximately **20–30% of comparisons**, sampled across clear, close and robustness pairs:

| Dimension                  | Allowed answers              |
| -------------------------- | ---------------------------- |
| Component quality          | A / B / Equal / Cannot judge |
| Whole-outfit coordination  | A / B / Equal / Cannot judge |
| Garment fit and proportion | A / B / Equal / Cannot judge |

These dimension judgements align with the three visual score groups and are used to train or validate the individual scoring branches. The overall A/B decision remains the supervision used to fit the final combination of branch outputs.

Do not require judges to rate every top, bottom, shoe and accessory in the main workflow. Detailed garment-level annotation is expensive and likely to be inconsistent, so it should be limited to a small diagnostic subset if component-level errors need investigation.

Important evaluation pairs should receive multiple independent judgements. Rater cohort and fashion-engagement information should be retained so the team can measure whether different parts of the target audience disagree.

Pair selection should progress from random coverage to active learning: prioritise comparisons where the experts disagree, the current model is near 50/50, or additional labels would improve coverage.

#### Webcam-like labelled image pool

The calibration images must resemble the frames that FITTED will score in production. Start with approximately **200–400 unique images** of people wearing complete outfits and use them to collect the planned **500–1,000 individual A/B decisions**. Each image should appear in several different pairings.

Prefer images with:

- the full body visible, including shoes;
- a mostly front-facing, neutral pose;
- one person per image;
- consistent crop and resolution;
- clear lighting without heavy filters;
- varied styles, colours, silhouettes, layering and formality;
- varied people, backgrounds, lighting and body proportions; and
- faces blurred or excluded so the task remains outfit-focused.

Do not show likes, prices, brands, captions or popularity cues to raters. Avoid product-only images, flat lays, garment close-ups, heavily obscured outfits and comparisons where framing quality makes the answer obvious.

Construct three pair groups:

1. **Clear contrasts** validate that raters understand the task.
2. **Close comparisons** provide the most useful fashion-preference signal.
3. **Robustness comparisons** test similar outfits across different people, backgrounds and lighting.

Use the prompt: **“Which outfit is better styled as a complete look? Judge the clothing, coordination and fit—not the person, photo quality or brand.”**

Randomise left/right placement and build train, validation and test splits by person, outfit and capture session before constructing pairs. An image or adjacent frame from the same outfit must never cross split boundaries. Important validation and test pairs should receive multiple independent ratings so inter-rater agreement and the realistic model ceiling can be measured.

Reason tags and dimension judgements should be collected only on their selected subsets to keep the primary task fast. `Cannot judge` labels train frame-quality rejection; they do not participate in preference training.

This dataset calibrates a low-capacity pairwise combiner over frozen expert outputs. It is not large enough to train or fully fine-tune a visual encoder from scratch.

### VLM role

For the hackathon, an image-capable VLM analyses the best synchronised frame pair when a battle is frozen or finalised. It returns structured component-quality, whole-outfit coordination, body-aware fit, holistic, frame-quality and explanation fields. The fallback's public score uses only the deterministic 45/30/25 dimensions; the holistic value is retained for diagnostics and as a candidate feature for the later learned combiner so it is not double-counted. The application may use the VLM explanation in the final result experience.

The VLM's single `componentQuality` value is a fallback approximation. The final component branch remains the garment-aware calculation above, using per-component style, category importance, detection confidence, and visibility.

Use **Gemini 3.6 Flash** for the hackathon's paired-image VLM fallback. Keep the provider boundary replaceable, but defer broad model comparison until after the hackathon unless Gemini blocks delivery.

The VLM should not continuously process the 30 FPS webcam stream. Live video remains independent; the VLM fallback uses the newest fresh pair when a battle is frozen or finalised, permits one request per room in flight and discards stale work. A final three-frame burst may be used to reduce sensitivity to a single pose. The later learned scorer, not the VLM fallback, is responsible for approximately 1 FPS live scoring. Periodic VLM polling every 2–3 seconds is optional experimentation only.

Streaming-video VLMs are a post-hackathon investigation for continuous commentary, garment movement or long-session memory. They are not required for outfit scoring, where the visual state changes slowly relative to the video frame rate.

### Final FITTED scoring function

The executable runtime contract and its remaining implementation checklist live in
[`docs/specs/scoring-spec.md`](specs/scoring-spec.md).

For a human-labelled pair, the calibration model compares the source-expert predictions:

```text
features(A, B) = [
  instagram(A) - instagram(B),
  depop(A) - depop(B),
  momentum(A) - momentum(B),
  component_quality(A) - component_quality(B),
  outfit_coordination(A) - outfit_coordination(B),
  body_fit(A) - body_fit(B),
  vlm_holistic(A) - vlm_holistic(B)
]
```

The initial combiner can be pairwise logistic regression:

```text
FITTED(A) =
    weight_instagram × instagram(A)
  + weight_depop     × depop(A)
  + weight_momentum  × momentum(A)
  + weight_component × component_quality(A)
  + weight_outfit    × outfit_coordination(A)
  + weight_body_fit  × body_fit(A)
  + weight_vlm       × vlm_holistic(A)

P(A wins) = sigmoid((FITTED(A) - FITTED(B)) / temperature)
```

The terms above are transformed model features, not an assumption that every raw
expert naturally produces a comparable `0..100` value. The trained scoring
artifact must version each expert's fitted centring, scaling, and clipping (or an
equivalent transform), and live inference must apply those exact transforms.
Calibration into a displayed `0..100` FITTED score is a separate output mapping.

The target-audience comparisons learn the expert weights and calibrate the final decision boundary. They are not expected to teach the vision encoder fashion knowledge from scratch.

Each source signal must be evaluated out of sample. Signals that do not improve agreement with held-out target-audience comparisons should receive no weight or be removed.

### Offline and live boundaries

Social-platform information is used only for offline dataset construction and training.

During a live battle:

```text
latest frame from Player A ─┐
                           ├──► quality check and preprocessing
latest frame from Player B ─┘               ↓
                                      visual encoder
                                             ↓
                                  trained experts and weights
                                             ↓
                         provisional score ranges + current edge
                                             ↓
                                smoothed, labelled live estimate
```

The live inference path must not require Instagram, Depop or any other training-data source to be available.

The live video frame rate must remain independent from the inference rate. The system should sample the newest pair of frames, allow only one comparison request in flight, discard stale work, and display the latest valid result.

Start at approximately **one comparison per second**. Increase the rate only if measured inference latency and hardware headroom allow it. The product does not need to classify every camera frame.

Live inference may use a faster and less accurate subset of the final signals. It
produces the provisional ranges defined in the result experience, not the final
winner. Freeze/finalisation invokes the most accurate configured path and is the
only operation that can publish and lock the authoritative exact result.

### Proposed inference output

The next response revision must include an explicit phase. A live response
contains per-player score ranges and a provisional leader; a final response
contains exact scores, a winner or draw, and a finalisation ID. The example below
shows the final variant; the complete union is defined in the scoring spec.

```json
{
  "phase": "final",
  "finalisationId": "string",
  "modelVersion": "string",
  "playerAScore": 72.4,
  "playerBScore": 61.8,
  "winner": "player_a",
  "winProbability": null,
  "breakdown": {
    "playerA": {
      "componentQuality": 70.8,
      "outfitCoordination": 78.1,
      "bodyFit": 69.5,
      "vlmHolistic": 74.0
    },
    "playerB": {
      "componentQuality": 64.2,
      "outfitCoordination": 58.9,
      "bodyFit": 62.7,
      "vlmHolistic": 63.5
    }
  },
  "frameQuality": {
    "playerA": "ok",
    "playerB": "ok"
  },
  "latencyMs": 180
}
```

`winProbability` must only be presented as confidence if it has been calibrated. Frame quality is a separate signal and must not be presented as model confidence.

### Evaluation plan

The first evaluation should use representative held-out image pairs and actual demo hardware.

Measure:

- pairwise agreement with human labels;
- performance on image-disjoint and person-disjoint test data;
- consistency when Player A and Player B are swapped;
- stability across several frames of the same outfit;
- sensitivity to background, lighting, pose, and camera quality;
- median and 95th-percentile inference latency;
- behaviour when one or both outfits cannot be judged.

Exact acceptance thresholds remain **TBD** until a baseline has been measured.

### ML decisions still required

- How exactly is the target audience defined and recruited?
- What Instagram and Depop data can be obtained lawfully and reliably?
- Which engagement and demand metrics are available for residual construction?
- Which confounding variables can be measured for each source?
- What image pool and held-out evaluation set will be used?
- Does DINOv2 Small or SigLIP 2 Base provide the stronger frozen representation on person-disjoint FITTED comparisons?
- Do Instagram and Depop experts add independent out-of-sample signal?
- Does visual style momentum add useful signal after the first two experts?
- Is full encoder fine-tuning eventually required?
- What final score mapping, live-band width, and draw threshold meet the measured calibration and continuity targets?
- How frequently should inference run?
- How will the system exclude face and body-type preference while still measuring garment fit and styling proportions?
- How will poor framing or incomplete outfit visibility be detected?
- How will model quality, bias, latency, and reliability be evaluated?

---

## 7. System Design

The prototype currently uses WebRTC for peer-to-peer video and Socket.IO for room signalling. Frame capture and a replaceable inference boundary also exist in the client.

These implementation choices are useful for the current demo but do not settle the complete system design.

### Proposed hackathon architecture

**Proposal — not yet a final decision.**

Do not rewrite the working signalling path for the sake of consolidating backend languages. Keep:

- Next.js for the application and UI;
- WebRTC for peer-to-peer video;
- the existing Node.js and Socket.IO server for rooms and WebRTC signalling.

Add a small Python inference service with:

- FastAPI;
- PyTorch and Transformers;
- `POST /v1/compare` for a pair of images;
- `POST /v1/garments` for a canonical outfit crop when the live garment gate passes;
- `GET /health` for demo readiness;
- models loaded once at service startup;
- no database and no retained frames for the prototype.

The hackathon inference service should combine, in priority order:

1. a working paired-image VLM response with structured output;
2. an Instagram residual expert built on cached frozen image embeddings, if the cleaned source data is ready;
3. a Depop expert only if it improves held-out FITTED comparisons; and
4. lightweight person, garment-visibility and pose signals described in [`cv-detection.md`](./specs/cv-detection.md).

The VLM is used at battle completion for holistic assessment and explanation. A StreamingVLM deployment, continuous 30 FPS model inference, full visual-encoder fine-tuning and production C++/TensorRT optimisation are explicitly deferred until after the scoring concept is validated.

Each browser selects only its own newest stable local crop, encodes it as WebP at
up to 640 pixels wide, and submits it with sample and capture-time metadata. The
Node room coordinator derives room and player role from the socket, briefly
retains only the newest valid submission per player, pairs submissions within a
three-second collection window, invokes comparison once for the room, and
broadcasts one authoritative result to both clients. Stale and superseded frames
are discarded and prototype frames are not persisted.

The existing Node room service owns pairing and locked battle-result state; the
Python inference service is stateless. Browser clients never own the
authoritative comparison and never use a decoded remote WebRTC frame as the
other player's scoring input.

```text
Laptop A <──────────── WebRTC video ────────────> Laptop B
   | local selected frame                 local selected frame |
   +----------------> server-side pairing coordinator <--------+
                              |
                      one fresh A/B pair
                              v
                    Python inference service
                              |
              preprocessing, VLM/scorer, result
                              v
                 authoritative broadcast to both
```

### Remaining system design decisions

**TBD:**

- the measured capture-time skew tolerance beyond the three-second collection deadline;
- deployment and hosting approach for the demo;
- whether STUN alone is sufficient or TURN is required for the intended environment;
- observability needed to diagnose failures during the demo.

### Implemented architecture

This is the shipped shape, not a proposal. Video is peer-to-peer and never
reaches a server; only signalling, garment perception and final scoring do.

```text
   Laptop A                                             Laptop B
  ┌──────────┐                                        ┌──────────┐
  │  camera  │                                        │  camera  │
  └────┬─────┘                                        └─────┬────┘
       │        ◄──── WebRTC media (P2P) ────►              │
       │                                                    │
       └──── Socket.IO signalling ──┐   ┌── Socket.IO ───────┘
            (SDP / ICE only)        ▼   ▼
                          ┌─────────────────────────┐
                          │  apps/web/server.mjs    │
                          │  Next 16 + Socket.IO    │
                          │  in-memory rooms, max 2 │
                          │  scoring coordinator    │
                          └───────────┬─────────────┘
                                      │ HTTP (frames)
                                      ▼
                          ┌─────────────────────────┐
                          │ services/inference      │
                          │ FastAPI                 │
                          │  ├─ perception.py       │  RF-DETR-Seg garments
                          │  ├─ vlm.py              │  Gemini final scoring
                          │  └─ scoring.py          │
                          └─────────────────────────┘
```

Client-side, pose detection runs in a Web Worker (`workers/pose-detection.worker.ts`)
against MediaPipe WASM vendored into `public/mediapipe/`, so frame-quality gating
and canonical cropping happen locally before anything is sent for perception.

Workspace layout:

| Path | Role |
|---|---|
| `apps/web` | Next.js 16 / React 19 frontend, Socket.IO signalling server, scoring coordinator, CV modules |
| `services/inference` | FastAPI scoring service — RF-DETR garment perception, Gemini VLM finalisation |
| `scripts/` | cross-workspace dev orchestration (`dev.mjs`, `python.mjs`, `setup-python.mjs`) |
| `docs/` | this PRD, `specs/cv-detection.md`, `specs/scoring-spec.md` |

Remaining architectural gap: **deployment**. Local development runs both
workspaces via `npm run dev`; no hosted target has been chosen.

---

## 8. Success Criteria

The hackathon demo is successful when:

- two laptops can create and join the same battle;
- both camera feeds appear and remain usable;
- outfit frames can be analysed;
- the system returns a comparison;
- both users can understand the result;
- the interaction feels responsive; and
- the full flow can be demonstrated reliably.

**TBD:** specific targets for latency, model quality, result stability, connection success rate, and supported browsers/devices.

---

## 9. Out of Scope for the Initial Prototype

- Persistent profiles or battle history.
- Social feeds.
- Matchmaking.
- Global leaderboards.
- Ecommerce or outfit purchasing.
- Virtual try-on.
- Production-scale infrastructure.

This list may be revisited after the MVP and nice-to-have scope are agreed.

---

## 10. Open Product Questions

- Does a player freeze the battle, does a timer end it, or are both supported?
- What final draw threshold is supported by target-audience labels?
- What makes a battle fun enough to repeat?
- What explanation should accompany a result?
- What language should the product use to avoid presenting subjective taste as objective fact?
- What happens when the model cannot make a reliable comparison?

---

## 11. Decisions Log

Only record choices here once the team has agreed to them.

| Area                     | Decision                                                                 | Status                     | Notes                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product format           | Two-player live camera battle                                            | Decided                    | Core prototype concept                                                                                                                           |
| Frontend                 | Next.js, React, TypeScript, Tailwind CSS, shadcn/ui                      | Decided                    | Current implementation                                                                                                                           |
| UI direction             | Continue from the current prototype                                      | Decided for hackathon      | Polish is allowed; no major redesign planned                                                                                                     |
| Live video               | WebRTC                                                                   | Current prototype choice   | Reassess only if it blocks a reliable demo                                                                                                       |
| Signalling               | Socket.IO                                                                | Current prototype choice   | Used for rooms and WebRTC negotiation                                                                                                            |
| Result format            | Provisional live ranges, then exact final scores and a winner or draw    | Decided for hackathon      | Live values are labelled estimates; only server finalisation can lock the verdict                                                                |
| Live-to-final continuity | Calibrate the live band against the final scorer                         | Decided for hackathon      | Start at ±5 points, target 80% coverage, widen to at most 16 total points, then fall back to qualitative live status rather than false precision |
| ML target                | Preference of the defined FITTED target audience                         | Current direction          | Social popularity supplies weak supervision; audience judgements calibrate the target                                                            |
| ML formulation           | Source experts combined into a pairwise FITTED score                     | Current direction          | Instagram and Depop first; style momentum later if useful                                                                                        |
| Visual score composition | Component quality 45%, whole-outfit coordination 30%, body-aware fit 25% | Initial prototype decision | Deterministic defaults; learn constrained weights from target-audience labels later                                                              |
| Personal attributes      | Face and body type excluded from the competitive score                   | Decided                    | Body-aware analysis measures garment fit and styling proportions only                                                                            |
| Primary encoder          | Benchmark DINOv2 Small and SigLIP 2 Base                                 | Proposed                   | Use frozen embeddings; do not make full fine-tuning a hackathon dependency                                                                       |
| Training                 | Frozen encoder, source-specific experts, pairwise logistic combiner      | Current direction          | Human A/B labels learn expert weights and calibration                                                                                            |
| Human labels             | 200–400 webcam-like outfits and 500–1,000 target-audience A/B decisions  | Initial plan               | Split by person/outfit/session; repeat important evaluation pairs                                                                                |
| VLM role                 | Final holistic assessment and explanation                                | Current direction          | Holistic output is diagnostic in fallback; deterministic 45/30/25 public score avoids double-counting                                            |
| VLM fallback model       | Gemini 3.6 Flash                                                         | Decided for hackathon      | Prioritise integration and FITTED-specific verification over a broad provider bake-off                                                           |
| StreamingVLM             | Deferred                                                                 | Decided for hackathon      | Revisit for continuous commentary, garment movement or long-session memory                                                                       |
| Live garment perception  | RF-DETR-Seg Small, approximately 1 FPS                                   | Time-boxed decision        | One candidate, 90-minute gate; cut the feature if latency, correctness, or provenance fails; no frozen-only substitute                           |
| Inference location       | Separate stateless Python service                                        | Implemented for hackathon  | Keeps ML dependencies out of the working signalling server                                                                                       |
| Frame transport          | Per-client local-frame submission                                        | Decided for hackathon      | Each player submits only its own selected local crop                                                                                             |
| Pairing authority        | Existing Node room service                                               | Implemented for hackathon  | Derives host/guest roles, pairs local crops, and locks/broadcasts the result                                                                     |
| Nice-to-have scope       | TBD                                                                      | Open                       | Decide after core-flow validation                                                                                                                |
