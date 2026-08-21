# FITTED — Product Requirements Document

## 1. Overview

**Working name:** FITTED  
**Status:** Hackathon prototype  
**Document status:** Draft — unresolved decisions are marked **TBD**

FITTED is a live fashion battle where two people connect through their cameras and an ML system compares their outfits.

The prototype should answer one central question: can an ML model act as a fun, fast referee for a live outfit comparison?

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

The current prototype is the baseline and is expected to be close to the final hackathon UI. Visual polish may continue, but a major redesign is not currently planned.

### Landing screen

- FITTED branding and short explanation of the battle.
- **Create Battle** action.
- **Join Battle** action.
- Room-code entry and validation.

### Battle room

- Symmetrical local and opponent video panels.
- Player labels and room code.
- Camera and peer-connection status.
- Waiting, connecting, analysing, disconnected, and error states.
- Live comparison result or score area.
- Controls for camera, copying the room code, freezing/resuming the current score, and leaving.

### Result experience

The current score and winner treatment may be used as the prototype presentation, but the final result behaviour depends on unresolved product and ML decisions.

**TBD:**

- continuous score, final result, or both;
- absolute FIT scores versus a head-to-head winner;
- how and when a battle ends;
- how much reasoning or confidence to show;
- how to communicate poor framing or an outfit that is not sufficiently visible.

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
visual style momentum
          ↓
source-signal ensemble
          ↓
500–1,000 target-audience pair comparisons
          ↓
pairwise FITTED scoring function
```

This is a teacher–student design:

- social and commercial data provide large-scale but noisy offline supervision;
- target-audience comparisons determine how the weak signals should be combined;
- the resulting visual scoring model runs without contacting social platforms during a live battle.

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

The first encoder candidate is **SigLIP 2 Base** because it supports general visual representation extraction and a prompt-based zero-shot baseline.

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

Important evaluation pairs should receive multiple independent judgements. Rater cohort and fashion-engagement information should be retained so the team can measure whether different parts of the target audience disagree.

Pair selection should progress from random coverage to active learning: prioritise comparisons where the experts disagree, the current model is near 50/50, or additional labels would improve coverage.

### Final FITTED scoring function

For a human-labelled pair, the calibration model compares the source-expert predictions:

```text
features(A, B) = [
  instagram(A) - instagram(B),
  depop(A) - depop(B),
  momentum(A) - momentum(B),
  component_quality(A) - component_quality(B),
  outfit_coordination(A) - outfit_coordination(B),
  body_fit(A) - body_fit(B)
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

P(A wins) = sigmoid((FITTED(A) - FITTED(B)) / temperature)
```

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
                              scores + winner + win probability
                                             ↓
                                      smoothed UI result
```

The live inference path must not require Instagram, Depop or any other training-data source to be available.

The live video frame rate must remain independent from the inference rate. The system should sample the newest pair of frames, allow only one comparison request in flight, discard stale work, and display the latest valid result.

Start at approximately **one comparison per second**. Increase the rate only if measured inference latency and hardware headroom allow it. The product does not need to classify every camera frame.

### Proposed inference output

```json
{
  "modelVersion": "string",
  "playerAScore": 72.4,
  "playerBScore": 61.8,
  "winner": "player_a",
  "winProbability": 0.74,
  "breakdown": {
    "playerA": {
      "componentQuality": 70.8,
      "outfitCoordination": 78.1,
      "bodyFit": 69.5
    },
    "playerB": {
      "componentQuality": 64.2,
      "outfitCoordination": 58.9,
      "bodyFit": 62.7
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
- Should SigLIP 2 Base be the primary encoder?
- Do Instagram and Depop experts add independent out-of-sample signal?
- Does visual style momentum add useful signal after the first two experts?
- Is full encoder fine-tuning eventually required?
- How will scores be calibrated and stabilised over time?
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
- `GET /health` for demo readiness;
- models loaded once at service startup;
- no database and no retained frames for the prototype.

Initially, the host browser can capture the latest local and remote video frames, send them together to `/v1/compare`, and relay the resulting battle state to the guest through the existing room connection. This avoids duplicate inference and guarantees that each result is based on one explicit image pair.

This coordinator approach must be tested for asymmetric WebRTC image quality. If it materially biases results, move to a design where each player sends their own local frame and the inference service pairs the latest submissions by room.

```text
Laptop A ◄──────────── WebRTC video ────────────► Laptop B
   │                                                 │
   └──── Socket.IO rooms, signalling and results ────┘
   │
   │ paired, rate-limited frame samples
   ▼
Python inference service
   │
   ├── preprocessing and frame-quality checks
   ├── frozen vision encoder
   └── pairwise scoring head
```

### System design to determine

**TBD:**

- where ML inference runs: browser, shared server, separate ML service, or a hybrid;
- whether each client submits its own frames or one client coordinates the comparison;
- how frames reach inference: HTTP, WebSocket, WebRTC data channel, or another mechanism;
- how two players' samples are paired into a fair comparison;
- where room and battle state are owned;
- whether a separate backend service is needed and, if so, its language and framework;
- result delivery and synchronisation between both players;
- retry, timeout, reconnection, and failure behaviour;
- privacy rules for captured frames, including whether any images are retained;
- deployment and hosting approach for the demo;
- whether STUN alone is sufficient or TURN is required for the intended environment;
- observability needed to diagnose failures during the demo.

### Architecture placeholder

Replace this section with the selected design once the decisions above have been made.

```text
Laptop A ◄──── live video / signalling ────► Laptop B
    │                                           │
    └──────────── comparison system ────────────┘
                          │
                          ▼
                    result to both players
```

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

- Is the primary output a score, a winner, or both?
- Is scoring continuous, frozen by a player, or finalised automatically?
- What makes a battle fun enough to repeat?
- What explanation should accompany a result?
- What language should the product use to avoid presenting subjective taste as objective fact?
- What happens when the model cannot make a reliable comparison?

---

## 11. Decisions Log

Only record choices here once the team has agreed to them.

| Area | Decision | Status | Notes |
| --- | --- | --- | --- |
| Product format | Two-player live camera battle | Decided | Core prototype concept |
| Frontend | Next.js, React, TypeScript, Tailwind CSS, shadcn/ui | Decided | Current implementation |
| UI direction | Continue from the current prototype | Decided for hackathon | Polish is allowed; no major redesign planned |
| Live video | WebRTC | Current prototype choice | Reassess only if it blocks a reliable demo |
| Signalling | Socket.IO | Current prototype choice | Used for rooms and WebRTC negotiation |
| Result format | TBD | Open | Absolute score, head-to-head result, or both |
| ML target | Preference of the defined FITTED target audience | Current direction | Social popularity supplies weak supervision; audience judgements calibrate the target |
| ML formulation | Source experts combined into a pairwise FITTED score | Current direction | Instagram and Depop first; style momentum later if useful |
| Visual score composition | Component quality 45%, whole-outfit coordination 30%, body-aware fit 25% | Initial prototype decision | Deterministic defaults; learn constrained weights from target-audience labels later |
| Personal attributes | Face and body type excluded from the competitive score | Decided | Body-aware analysis measures garment fit and styling proportions only |
| Primary encoder | SigLIP 2 Base | Proposed | Benchmark against FashionCLIP on representative data |
| Training | Frozen encoder, source-specific experts, pairwise logistic combiner | Current direction | Human A/B labels learn expert weights and calibration |
| Human labels | 500–1,000 target-audience A/B decisions | Initial plan | Use repeated judgements for important evaluation pairs |
| Inference location | Separate Python service | Proposed | Keeps ML dependencies out of the working signalling server |
| Frame transport | Paired HTTP request from the host | Proposed for first version | Revisit if remote-stream quality creates bias |
| Nice-to-have scope | TBD | Open | Decide after core-flow validation |
