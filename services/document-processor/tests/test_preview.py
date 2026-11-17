from hashlib import sha256
from io import BytesIO
from uuid import uuid4
from types import SimpleNamespace

import pymupdf
import pytest
from PIL import Image
from fastapi.testclient import TestClient
from document_processor import preview
from document_processor.main import app
from document_processor.models import ProcessingError


def source(monkeypatch, data, extension, page=1):
    tenant, doc = uuid4(), uuid4()
    monkeypatch.setenv("S3_BUCKET", "preview-tests")
    body = SimpleNamespace(iter_chunks=lambda **_: iter([data]), close=lambda: None)
    monkeypatch.setattr(preview, "storage_client", lambda: SimpleNamespace(get_object=lambda **_: {"Body": body}))
    return preview.PreviewRequest(tenant_id=tenant, document_id=doc, run_id=uuid4(), page_number=page,
        source={"bucket": "preview-tests", "key": f"tenants/{tenant}/documents/{doc}/source{extension}",
        "extension": extension, "size_bytes": len(data), "sha256": sha256(data).hexdigest()})


def test_renders_one_actual_pdf_page_with_bounded_dimensions(monkeypatch):
    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((50, 50), "Original source preview")
        pdf.new_page().insert_text((50, 50), "Second page")
        request = source(monkeypatch, pdf.tobytes(), ".pdf", 2)
    output = preview.render_preview(request)
    with Image.open(BytesIO(output)) as image:
        assert image.format == "PNG" and max(image.size) <= 1600


def test_renders_the_requested_tiff_frame_without_ocr(monkeypatch):
    output = BytesIO()
    first, second = Image.new("RGB", (40, 30), "red"), Image.new("RGB", (40, 30), "blue")
    first.save(output, format="TIFF", save_all=True, append_images=[second])
    request = source(monkeypatch, output.getvalue(), ".tiff", 2)
    with Image.open(BytesIO(preview.render_preview(request))) as image:
        assert image.getpixel((0, 0)) == (0, 0, 255)


def test_checks_source_hash_and_rejects_cross_bucket_access(monkeypatch):
    output = BytesIO()
    Image.new("RGB", (10, 10)).save(output, format="PNG")
    request = source(monkeypatch, output.getvalue(), ".png")
    request.source.sha256 = "0" * 64
    with pytest.raises(ProcessingError, match="CHECKSUM"):
        preview.render_preview(request)
    request.source.bucket = "other-tenant-storage"
    with pytest.raises(ProcessingError, match="REJECTED"):
        preview.render_preview(request)


def test_preview_endpoint_requires_internal_authentication():
    with TestClient(app) as client:
        assert client.post("/internal/preview", json={}).status_code == 401
