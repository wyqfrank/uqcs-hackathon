# Vendored MediaPipe assets

These files are self-hosted so the browser detector does not depend on a CDN during the demo.

- Runtime: `@mediapipe/tasks-vision` 1.0.1, Apache-2.0.
- Model: [Pose Landmarker Lite float16, version 1](https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task).
- Model SHA-256: `59929E1D1EE95287735DDD833B19CF4AC46D29BC7AFDDBBF6753C459690D574A`.
- SIMD WASM SHA-256: `8DA277A733926EACD0474B8704B36742D6EC3231C57A860C5B889DFF8F1DF886`.
- Module WASM SHA-256: `2DABD8E23C60984628BEB7BB338764C81A08E6837145273F59578684B5D53C1B`.
- Non-SIMD WASM SHA-256: `A28483CD42E74E855BF5EBDB6B40D9B66A5B49E35E95020BC97669E6822A3192`.

The JavaScript WASM loaders are copied unchanged from the pinned npm package. When upgrading MediaPipe, replace the complete runtime directory and record new hashes here.
