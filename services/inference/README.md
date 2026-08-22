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
- `POST /v1/compare` accepts `player_a` and `player_b` image fields as multipart
  uploads and returns the typed comparison result documented in the PRD.

The initial engine deliberately returns `503` from comparison requests. Replace
`create_engine()` in `src/fitted_inference/engine.py` only after an evaluated model
is available; load model weights there once during application startup.
