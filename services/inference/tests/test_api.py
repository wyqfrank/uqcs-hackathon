from fastapi.testclient import TestClient

from fitted_inference.main import app


def test_health_reports_unconfigured_model() -> None:
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "fitted-inference",
        "modelReady": False,
        "modelVersion": "unconfigured",
    }


def test_compare_is_explicitly_unavailable_without_model() -> None:
    files = {
        "player_a": ("player-a.webp", b"frame-a", "image/webp"),
        "player_b": ("player-b.webp", b"frame-b", "image/webp"),
    }

    with TestClient(app) as client:
        response = client.post("/v1/compare", files=files)

    assert response.status_code == 503
    assert "No inference model is configured" in response.json()["detail"]


def test_compare_rejects_unsupported_media() -> None:
    files = {
        "player_a": ("player-a.txt", b"not an image", "text/plain"),
        "player_b": ("player-b.webp", b"frame-b", "image/webp"),
    }

    with TestClient(app) as client:
        response = client.post("/v1/compare", files=files)

    assert response.status_code == 415
