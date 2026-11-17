from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from document_processor.main import app


@pytest.mark.parametrize("path", ["/health", "/health/ready"])
def test_health_response(path: str) -> None:
    with TestClient(app) as client:
        response = client.get(path)
    assert response.status_code == 200
    payload = response.json()
    assert payload["service"] == "document-processor"
    assert payload["status"] == "ok"
    assert datetime.fromisoformat(payload["timestamp"].replace("Z", "+00:00")).tzinfo is not None
    assert set(payload) <= {"service", "status", "timestamp", "checks"}


@pytest.mark.parametrize("path", ["/process", "/extract", "/docs", "/openapi.json"])
def test_processing_and_documentation_are_not_exposed(path: str) -> None:
    with TestClient(app) as client:
        response = client.get(path)
    assert response.status_code == 404
