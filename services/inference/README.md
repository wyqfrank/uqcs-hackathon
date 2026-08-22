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
- `POST /v1/compare` accepts paired image fields plus battle, finalisation, pair,
  sample, and capture-time identity as multipart fields. It returns a typed final
  or not-scoreable result.
- `GET /v1/garments/health` reports whether garment perception is configured.
- `POST /v1/garments` accepts one canonical outfit crop in the `image` multipart
  field and returns canonical garment categories, normalised boxes, confidence,
  the diagnostic text prompt matched by the model, and explicit per-category
  detection state. Consumers should use the canonical category rather than treat
  the matched prompt as a reliable fine-grained subtype.

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

The real-provider smoke test is deliberately excluded from the default suite. To
run it with two consented JPEG/WebP outfit images, set `FITTED_RUN_GEMINI_SMOKE=1`,
`FITTED_SMOKE_PLAYER_A_PATH`, and `FITTED_SMOKE_PLAYER_B_PATH` alongside the
Gemini variables above, then run:

```powershell
npm run test:api -- -k real_gemini_pair
```

## Garment perception

The first fashion-perception baseline uses Grounding DINO Tiny with a reduced,
product-owned taxonomy. Install the optional ML dependencies and enable the model:

```powershell
.\.venv\Scripts\python.exe -m pip install -e "services/inference[dev,ml]"
$env:FITTED_GARMENT_MODEL_ID = "IDEA-Research/grounding-dino-tiny"
npm run dev:api
```

The first configured startup downloads the model weights. The zero-shot adapter
reports `not_detected` when a prompted category has no accepted box; it does not
claim that the category is definitely absent. A later calibrated presence model
may emit the separate `not_present` state.

Set `FITTED_GARMENT_LOCAL_FILES_ONLY=true` after the checkpoint is cached, or in
deployments where startup must never contact the Hugging Face Hub.
