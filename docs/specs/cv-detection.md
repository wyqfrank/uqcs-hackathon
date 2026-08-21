# CV Detection and Frame Preparation Specification

**Product:** MOG  
**Status:** Draft  
**Scope:** Live person detection, pose tracking, frame-quality validation, and canonical outfit cropping  
**Out of scope:** Taste scoring, social-signal training, pairwise ranking, and production deployment

## 1. Purpose

The detection pipeline must convert a moving webcam feed into a recent, stable, consistently framed outfit image that is suitable for the visual encoder and scoring model.

Detection is an input-quality system. It must not decide whether an outfit is fashionable and must not use detection confidence as a fashion score.

```text
30 FPS webcam video ─────────────────────────► displayed video
          │
          └── latest frame only
                    ↓
          pose detection at approximately 10 FPS
                    ↓
          framing, visibility, motion, and quality checks
                    ↓
          stable padded full-outfit crop
                    ↓
          scoring capture at approximately 1 FPS
```

## 2. Goals

- Keep the displayed camera feed smooth while detection runs.
- Confirm that exactly one person is available for scoring.
- Determine whether enough of the outfit is visible.
- Follow normal movement without creating a stale frame queue.
- Reject or temporarily pause scoring for unusable frames.
- Produce a canonical padded crop without stretching the image.
- Use the same frame-preparation rules for training, evaluation, and live inference.
- Keep continuous detection local to the browser where practical.

## 3. Non-goals for the first implementation

- Identifying individual garment categories.
- Segmenting tops, bottoms, dresses, shoes, or accessories.
- Measuring garment fit from body landmarks.
- Recognising brands or estimating garment value.
- Scoring a person's face, body type, attractiveness, or identity.
- Reliably classifying front, side, and back outfit views.
- Building a guided multi-view outfit scan.

Garment detection and multi-view capture are later experiments and must not block the first whole-outfit scoring baseline.

## 4. Initial model choice

Use **MediaPipe Pose Landmarker** as the initial person and pose model.

Initial configuration:

| Setting | Initial value | Notes |
| --- | --- | --- |
| Model | Pose Landmarker Lite | Benchmark against Full before finalising |
| Running mode | `VIDEO` | Enables tracking across decoded video frames |
| Maximum poses | `2` | Detect a second person so multi-person frames can be rejected |
| Segmentation masks | Disabled | Avoid continuous mask-generation cost initially |
| Detection target | Approximately 10 FPS | Independent of the 30 FPS video presentation |
| In-flight detections | Maximum 1 | New frames are dropped while detection is busy |

MediaPipe provides 33 body landmarks, landmark visibility, and optional person segmentation. The Web implementation should run outside the React rendering path, preferably in a Web Worker. See the [official Pose Landmarker documentation](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js).

## 5. Client-side architecture

Each browser should analyse its own uncompressed local camera feed. The browser should not wait for a server round trip before showing framing guidance.

```text
HTMLVideoElement at camera frame rate
              │
              ├──► normal video rendering
              │
              └──► requestVideoFrameCallback scheduler
                               │
                      latest-frame slot
                               │
                       Web Worker detector
                               │
                  timestamped detection result
                               │
                    temporal state machine
                               │
                     candidate-frame buffer
```

The final transport of valid crops to the inference service is intentionally left to the inference-service specification. The detection contract must work whether the host coordinates both players or each client submits its own local crop.

## 6. Scheduling and backpressure

Use `requestVideoFrameCallback()` where supported so detection is scheduled only when a new video frame exists.

Rules:

1. Cap detection scheduling at approximately one frame every 100 ms.
2. Allow only one detection operation in flight.
3. If the detector is busy, discard the pending frame and use the newest frame next.
4. Never queue frames for later detection.
5. Ignore detection results that arrive outside the accepted staleness window.
6. Timestamp every submitted frame and returned result.

```text
frame 1 ──► detecting
frame 2 ──► dropped
frame 3 ──► dropped
frame 4 ──► newest available frame after detection completes
```

If average detection time approaches or exceeds the scheduling interval, reduce the detection frequency instead of allowing work to accumulate.

## 7. Detection result contract

```ts
type OutfitFrameStatus =
  | "valid"
  | "no_person"
  | "multiple_people"
  | "partial_outfit"
  | "too_close"
  | "too_far"
  | "low_light"
  | "blurred"
  | "moving_too_fast"
  | "detector_unavailable";

type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type FrameQualityMetrics = {
  poseConfidence: number;
  landmarkVisibility: number;
  personFrameCoverage: number;
  sharpness: number;
  brightness: number;
  motion: number;
};

type DetectedOutfitFrame = {
  capturedAt: number;
  status: OutfitFrameStatus;
  personBox: NormalizedRect | null;
  cropBox: NormalizedRect | null;
  landmarks: PoseLandmark[];
  quality: FrameQualityMetrics;
};
```

The exact metric scales must be documented alongside the implementation. Raw detector confidence must not be exposed to users as fashion confidence.

## 8. Frame-quality classification

### 8.1 Person count

- Zero detected poses → `no_person`.
- More than one sufficiently confident pose → `multiple_people`.
- Exactly one sufficiently confident pose → continue evaluating the frame.

### 8.2 Required body visibility

The first implementation should evaluate grouped landmarks rather than requiring every landmark independently:

- upper body: left/right shoulders;
- torso: left/right hips;
- legs: left/right knees;
- lower extent: ankles, heels, or foot-index landmarks.

A scoreable full-outfit frame must provide reliable torso and leg evidence plus enough lower-extent evidence to determine that the outfit is not cut off. Exact confidence thresholds remain tunable until evaluated on representative webcam fixtures.

Long dresses, wide trousers, layering, and partial self-occlusion must be included in the fixture set so landmark visibility rules do not systematically reject valid outfits.

### 8.3 Framing

Reject or pause scoring when:

- the detected person occupies too little of the frame;
- the person fills the frame so tightly that padding cannot be added;
- the calculated person bounds touch the frame edge;
- the head, torso, legs, or feet appear cropped;
- there is insufficient surrounding space for bags, outerwear, or silhouette.

Initial tunable values:

| Parameter | Initial value |
| --- | --- |
| Minimum person height | 40% of frame height |
| Maximum person height | 92% of frame height |
| Minimum border clearance | 3% of frame dimension |
| Crop padding | 15% around detected bounds |

These values are starting points, not acceptance criteria. Fixture evaluation must determine the final thresholds.

### 8.4 Brightness and blur

Brightness and sharpness checks should use inexpensive image statistics on a small grayscale sample.

- Brightness should be measured primarily within the person crop.
- Blur detection should distinguish camera softness from rapid motion where practical.
- Device-specific thresholds must be calibrated on the intended demo laptops.
- A single low-quality observation must not immediately invalidate an otherwise stable stream.

### 8.5 Motion

Estimate motion using changes in normalised landmarks and the person box between detections.

- Normal movement should keep tracking active.
- Rapid turns or high landmark displacement should return `moving_too_fast` for capture selection.
- The displayed camera must remain uninterrupted.
- The previous score may remain visible while capture is paused.

Pose detection tracks motion; it does not by itself classify whether the user is facing front, side, or back.

## 9. Temporal stability

Use hysteresis so transient misses do not make the UI flicker.

Initial state rules:

- Enter `valid` after 2 consecutive valid detections.
- Leave `valid` after 3 consecutive invalid detections.
- Retain the last usable pose for up to 300 ms during a brief tracking miss.
- Do not select a result older than 300 ms for a new scoring request.

Landmarks and crop bounds should use temporal smoothing. An initial exponential smoothing factor of `0.4` for the newest observation may be evaluated:

```text
smoothed = 0.4 × newest + 0.6 × previous
```

Smoothing must not allow an old crop to lag significantly behind a moving person.

## 10. Canonical crop

The crop must preserve the complete visible outfit and enough context for silhouette, layering, shoes, headwear, and carried accessories.

Crop algorithm:

1. Calculate bounds from reliable pose landmarks and the detector's person region.
2. Expand the bounds by the configured padding.
3. Preserve available space around extremities and likely accessories.
4. Clamp the expanded rectangle to the source frame.
5. Reject the frame if clamping removes required outfit regions.
6. Pad to the encoder's expected aspect ratio.
7. Resize without stretching.

Do not create tight per-garment crops for the whole-outfit scoring path.

Face blurring and neutral-background segmentation should be controlled experiments:

- baseline: padded person crop;
- ablation A: padded crop with face blurred;
- ablation B: person mask over a neutral background.

The same selected preprocessing variant must be applied to social-source images, human-labelled images, evaluation fixtures, and live webcam frames.

## 11. Candidate-frame selection

Maintain a small buffer of recent valid candidates rather than automatically scoring the frame nearest the timer tick.

```ts
type CandidateFrame = {
  capturedAt: number;
  crop: ImageBitmap;
  quality: FrameQualityMetrics;
};
```

Initial behaviour:

- retain up to 5 recent candidates;
- remove candidates older than 300 ms;
- prefer high landmark visibility and sharpness;
- penalise excessive motion;
- select no frame when every recent candidate is unusable;
- preserve the previous score when a scoring tick is skipped.

The selection formula must be deterministic for the same candidate set.

## 12. Garment detection experiment

Garment detection is not a prerequisite for the first whole-outfit ranker.

If component-level analysis is explored, begin with a server-side open-vocabulary detection experiment using a fixed reduced taxonomy:

```text
top
bottoms
one-piece / dress
outerwear
shoes
bag
headwear
other accessory
```

Grounding DINO is a candidate for the initial zero-shot experiment. Fashionpedia and DeepFashion2 may provide useful categories, masks, landmarks, or fine-tuning data.

Requirements for any garment detector:

- evaluate on actual webcam crops, not only source-dataset images;
- distinguish `not present` from `not detected`;
- handle dresses without requiring separate tops and bottoms;
- avoid making optional garments mandatory;
- never multiply fashion quality directly by raw detection confidence;
- demonstrate measurable improvement over the whole-outfit baseline before becoming an MVP dependency.

Segmentation should only be added if bounding boxes are proven insufficient for a measured requirement.

## 13. Multi-view and spinning

Ordinary movement is supported. Rapid movement may temporarily pause capture while pose tracking continues.

For the first version:

- prefer stable, primarily frontal frames for scoring;
- do not score a random blurred phase of a spin;
- keep the last stable result visible during rapid turns;
- do not claim that pose landmarks alone distinguish front from back.

A future guided scan may collect stable front, side, and back keyframes and pool their embeddings. This requires a separate orientation and multi-view specification.

## 14. Privacy and data handling

- Continuous pose detection should run locally where practical.
- Do not persist raw webcam frames as part of detection.
- Keep only the small in-memory candidate buffer required for selection.
- Release or close discarded `ImageBitmap`, `VideoFrame`, canvas, and mask resources promptly.
- Transmit only frames selected for inference.
- Document any future storage of captured or labelled webcam images separately and obtain appropriate consent.

## 15. Performance targets

Initial engineering targets on the intended demo laptop:

| Measure | Target |
| --- | --- |
| Displayed webcam | Approximately 30 FPS without visible detection-induced stutter |
| Pose scheduling | Approximately 10 FPS |
| Detection queue depth | 0 pending frames; maximum 1 in flight |
| Framing-feedback latency | Under 150 ms where hardware permits |
| Maximum candidate age | 300 ms |
| Scoring capture rate | Approximately 1 FPS |

Measured performance must be recorded for both players' intended devices. If targets are missed, reduce detection frequency before reducing video quality.

## 16. Testing and validation

### Unit tests

- Landmark-group visibility classification.
- Person-box and padded-crop calculations.
- Bounds clamping and aspect-ratio padding.
- Temporal hysteresis state transitions.
- Motion calculation.
- Candidate expiry and deterministic selection.
- Resource cleanup and worker error handling where testable.

### Fixture set

Create at least 50–100 representative stills or short sequences covering:

- correctly framed outfits;
- person too near and too far;
- cropped head, torso, legs, and shoes;
- multiple people;
- no person;
- low light and backlighting;
- motion blur;
- dark clothing;
- dresses, skirts, wide-leg trousers, and layered outerwear;
- bags, hats, and accessories extending beyond the body;
- front, side, back, and turning poses;
- varied body shapes, skin tones, mobility, and gender presentation.

Training, tuning, and evaluation fixtures must be separated where thresholds are learned from the data.

### Integration tests

- Video remains interactive while the worker runs.
- No frame queue develops during sustained motion.
- Detection results retain correct timestamps.
- A brief miss does not cause UI flicker.
- A stale result is never sent as a new scoring frame.
- Camera stop, restart, room leave, and component unmount release detection resources.

### Acceptance criteria before finalising this spec

- Pose Lite and Pose Full are benchmarked on the intended laptops.
- Initial thresholds are evaluated on the fixture set.
- Valid crops retain the complete outfit and accessories at an agreed rate.
- False acceptance of cropped or multi-person frames is measured.
- Motion behaviour is tested with walking, turning, and a controlled spin.
- The selected preprocessing variant is evaluated for score stability and person/background bias.
- Client-versus-host detection ownership is reconciled with the inference-service design.

## 17. Proposed file organisation

```text
hooks/
  useOutfitDetection.ts

lib/
  cv/
    crop.ts
    frame-quality.ts
    motion.ts
    types.ts

workers/
  pose-detection.worker.ts
```

Keep pure crop, quality, motion, and state-transition logic outside React and the worker so it can be unit tested directly.

## 18. Implementation sequence

- [ ] Build a still-image MediaPipe spike and debug overlay.
- [ ] Create and classify the initial fixture set.
- [ ] Implement landmark visibility and framing checks.
- [ ] Implement deterministic padded canonical cropping.
- [ ] Compare Pose Lite and Pose Full on target hardware.
- [ ] Move video detection into a Web Worker.
- [ ] Implement latest-frame scheduling with zero queueing.
- [ ] Add temporal smoothing and hysteresis.
- [ ] Add brightness, blur, and motion metrics.
- [ ] Implement the recent candidate-frame buffer and selector.
- [ ] Integrate detection status into the battle UI.
- [ ] Connect selected crops to the visual-encoder baseline.
- [ ] Test camera restart, disconnect, and cleanup behaviour.
- [ ] Run face-blur and background-neutralisation ablations.
- [ ] Decide whether garment detection adds enough value for the MVP.

## 19. Open decisions

- Pose Lite versus Pose Full after benchmarking.
- Final landmark visibility and framing thresholds.
- Exact brightness, blur, and motion thresholds.
- Whether full-foot visibility is mandatory or partial outfits can be scored without shoes.
- Whether face blurring becomes the default preprocessing path.
- Whether background segmentation improves fairness without removing useful accessories or silhouette.
- Whether detection runs independently on each local client or the host coordinates both feeds.
- Minimum browser support and fallback behaviour.
- Whether garment boxes or masks materially improve target-audience preference accuracy.

This document becomes **Final** only after the acceptance criteria are met and the open decisions required for the MVP are resolved.
