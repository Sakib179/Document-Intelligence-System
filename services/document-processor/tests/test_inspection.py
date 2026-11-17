from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from document_processor.inspection import InspectionError, InspectionLimits, inspect_file
from document_processor.main import app
from create_ingestion_fixtures import create_fixtures


@pytest.fixture(scope="module")
def fixtures(tmp_path_factory):
    directory = tmp_path_factory.mktemp("ingestion-fixtures")
    create_fixtures(directory)
    return directory


@pytest.mark.parametrize("extension,pages", [("pdf", 2), ("jpg", 1), ("jpeg", 1), ("png", 1), ("tif", 2), ("tiff", 2), ("xlsx", 2), ("xls", 2), ("csv", 1)])
def test_real_formats_and_logical_page_counts(fixtures: Path, extension: str, pages: int):
    result = inspect_file(fixtures / ("valid." + extension), "." + extension, InspectionLimits())
    assert result["pageCount"] == pages
    if extension in {"xlsx", "xls"}:
        assert result["worksheetNames"] == ["Invoices", "Other sheet"]


@pytest.mark.parametrize("filename,extension,code", [
    ("fake.pdf", ".pdf", "SIGNATURE_MISMATCH"), ("fake.xls", ".xls", "CORRUPT_FILE"),
    ("fake.xlsx", ".xlsx", "SIGNATURE_MISMATCH"), ("valid.png", ".jpg", "SIGNATURE_MISMATCH"),
    ("invalid.csv", ".csv", "CORRUPT_FILE"), ("traversal.xlsx", ".xlsx", "UNSAFE_ARCHIVE"),
    ("bomb.xlsx", ".xlsx", "ARCHIVE_LIMIT_EXCEEDED"), ("encrypted.pdf", ".pdf", "ENCRYPTED_FILE_UNSUPPORTED"),
])
def test_invalid_container_types(fixtures: Path, filename: str, extension: str, code: str):
    with pytest.raises(InspectionError) as caught:
        inspect_file(fixtures / filename, extension, InspectionLimits())
    assert caught.value.code == code


@pytest.mark.parametrize("extension", ["pdf", "tiff", "xlsx", "xls"])
def test_page_limit(fixtures: Path, extension: str):
    with pytest.raises(InspectionError) as caught:
        inspect_file(fixtures / ("valid." + extension), "." + extension, InspectionLimits(max_pages=1))
    assert caught.value.code == "PAGE_LIMIT_EXCEEDED"


def test_byte_and_pixel_limits(fixtures: Path):
    with pytest.raises(InspectionError) as caught:
        inspect_file(fixtures / "valid.pdf", ".pdf", InspectionLimits(max_bytes=1))
    assert caught.value.code == "FILE_TOO_LARGE"
    with pytest.raises(InspectionError) as caught:
        inspect_file(fixtures / "valid.png", ".png", InspectionLimits(max_image_pixels=1))
    assert caught.value.code == "IMAGE_PIXEL_LIMIT_EXCEEDED"


@pytest.mark.parametrize("filename", ["utf16.csv", "single.csv"])
def test_csv_text_encodings_and_single_column(fixtures: Path, filename: str):
    assert inspect_file(fixtures / filename, ".csv", InspectionLimits())["pageCount"] == 1


def test_csv_rejects_binary_and_markup(tmp_path: Path):
    for content in [b"MZ\x00binary", b"<html>not CSV</html>"]:
        path = tmp_path / "fake.csv"
        path.write_bytes(content)
        with pytest.raises(InspectionError):
            inspect_file(path, ".csv", InspectionLimits())


def test_internal_http_authentication_and_inspection(fixtures: Path, monkeypatch):
    monkeypatch.setenv("PROCESSOR_INTERNAL_TOKEN", "test-only-processor-token-not-a-secret")
    with TestClient(app) as client:
        denied = client.post("/internal/inspect", files={"file": ("valid.pdf", (fixtures / "valid.pdf").read_bytes(), "application/pdf")})
        assert denied.status_code == 401
        accepted = client.post("/internal/inspect", headers={"authorization": "Bearer test-only-processor-token-not-a-secret"}, files={"file": ("valid.pdf", (fixtures / "valid.pdf").read_bytes(), "application/pdf")})
        assert accepted.status_code == 200
        assert accepted.json()["pageCount"] == 2


def test_internal_http_size_limit(fixtures: Path, monkeypatch):
    monkeypatch.setenv("PROCESSOR_INTERNAL_TOKEN", "test-only-processor-token-not-a-secret")
    monkeypatch.setenv("UPLOAD_MAX_FILE_BYTES", "1")
    with TestClient(app) as client:
        response = client.post("/internal/inspect", headers={"authorization": "Bearer test-only-processor-token-not-a-secret"}, files={"file": ("valid.pdf", (fixtures / "valid.pdf").read_bytes(), "application/pdf")})
        assert response.status_code == 413
