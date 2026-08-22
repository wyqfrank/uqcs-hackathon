# FITTED inference service

This package owns online image preprocessing and paired-outfit inference. Offline
training code and datasets should not be imported by this service.

## Local development

From the repository root:

```powershell
npm run setup
npm run dev:api
```

The API runs at `http://localhost:8000`; its OpenAPI UI is available at
`http://localhost:8000/docs`.

## Endpoints

- `GET /health` reports process health and whether a model is ready.
- `POST /v1/compare` accepts one to three chronological Player A/B image pairs
  plus battle, finalisation, pair, sample, and capture-time identity as repeated
  multipart fields. It evaluates the burst in one provider request and returns a
  typed final or not-scoreable result.
- `GET /v1/garments/health` reports whether garment perception is configured.
- `POST /v1/garments` accepts one canonical outfit crop in the `image` multipart
  field and returns canonical garment categories, normalised boxes, confidence,
  the diagnostic text prompt matched by the model, and explicit per-category
  detection state. Consumers should use the canonical category rather than treat
  the matched prompt as a reliable fine-grained subtype.
- `POST /v1/garments/pair` accepts authoritative Player A/B sample identity and
  two canonical crops. It runs one detector batch and returns both ordered
  garment responses for the live perception lane.

The engine deliberately returns `503` unless the VLM fallback is configured. To
enable Gemini final scoring:

```powershell
.venv\Scripts\python.exe -m pip install -e "services/inference[dev,vlm]"
$env:GEMINI_API_KEY = "replace-me"
$env:FITTED_SCORING_BACKEND = "vlm_fallback"
npm run dev:api
```

Optional settings select the model, media resolution, prompt version, and timeout;
see `.env.example`. The API validates actual image decodability before provider
inference, never uses the VLM holistic diagnostic in the deterministic 45/30/25
score, and leaves win probability unset pending calibration.

`src/fitted_inference/scoring.py` supplies the deterministic 45/30/25 calculation
used by the final VLM path and defines a versioned pairwise scoring artifact for
the later learned scorer. The learned pairwise head is not wired into the image
endpoint until real expert outputs are available. See `docs/specs/scoring-spec.md`
for the training and evaluation checklist.

## Confirming final VLM calls

Watch the web/server terminal during finalisation. It emits payload-free events:

```text
[scoring] VLM request started
[scoring] VLM request completed
```

The metadata includes battle, finalisation, pair and sample-count identity plus
the returned phase, model version and latency. The inference terminal also logs
the corresponding `POST /v1/compare` HTTP status. If the web terminal instead
shows `[scoring] final capture unavailable`, no VLM request was made; its slot
metadata identifies whether Player A or B returned a frame, reported unavailable,
or missed the response deadline. These diagnostics never include image bytes or
appearance descriptions.

The real-provider smoke test is deliberately excluded from the default suite. To
run it with two consented JPEG/WebP outfit images, set `FITTED_RUN_GEMINI_SMOKE=1`,
`FITTED_SMOKE_PLAYER_A_PATH`, and `FITTED_SMOKE_PLAYER_B_PATH` alongside the
Gemini variables above, then run:

```powershell
npm run test:api -- -k real_gemini_pair
```

## Garment perception

The live candidate is RF-DETR-Seg Small with a pinned Fashionpedia checkpoint.
Use a CUDA-enabled PyTorch 2.12.1 build appropriate for the machine, then install
the exact adapter dependencies:

```powershell
.\.venv\Scripts\python.exe -m pip install -e "services/inference[dev,rf]"
npm run setup:model
$env:FITTED_GARMENT_BACKEND = "rfdetr"
$env:FITTED_GARMENT_CHECKPOINT_PATH = ".\models\rfdetr-fashionpedia\checkpoint_best_ema.pth"
$env:FITTED_GARMENT_DEVICE = "cuda"
npm run dev:api
```

The service verifies revision
`f1b64c11fa42d2f7455708b7a05f81c015461427`, SHA-256
`aafefc440ea8f3f388e894a898e4270a2eeb6e38a3c3ffd3751d07d0f30b26bb`,
the exact 46-class Fashionpedia order, CUDA availability, and checkpoint
structure before enabling FP16 inference. It ignores the 19 garment-part classes
and returns the reduced FITTED categories and boxes; masks are not exposed.

Run the hardware benchmark against consented crops stored outside Git:

```powershell
.\.venv\Scripts\python.exe services\inference\scripts\benchmark_garments.py `
  --checkpoint .\models\rfdetr-fashionpedia\checkpoint_best_ema.pth `
  --fixtures C:\path\to\consented-crops
```

Grounding DINO Tiny remains available through the `ml` extra with
`FITTED_GARMENT_BACKEND=grounding_dino`; it is a diagnostic baseline only. Both
adapters report `not_detected` when a category has no accepted box and never turn
a missing category into a zero score.

Set `FITTED_GARMENT_LOCAL_FILES_ONLY=true` after the checkpoint is cached, or in
deployments where Grounding DINO startup must never contact the Hugging Face Hub.
