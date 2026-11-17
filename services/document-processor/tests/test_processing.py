import gzip
import hashlib
import io
import json
from pathlib import Path
import re
from uuid import uuid4
import zipfile

import numpy as np
import openpyxl
from PIL import Image
import pymupdf
import pytest
from fastapi.testclient import TestClient
import xlwt

from document_processor.engine import ProcessingLimits, process_isolated, process_local
from document_processor.main import app
from document_processor.models import ProcessRequest, ProcessingError
from document_processor.ocr import capabilities, preprocess
from document_processor import processors
from document_processor.inspection import InspectionLimits, inspect_file
from create_processing_fixtures import text_image


def request_for(path):
    tenant, document = uuid4(), uuid4()
    return ProcessRequest(tenant_id=tenant, document_id=document, run_id=uuid4(),
        source={"bucket": "test-documents", "key": f"tenants/{tenant}/documents/{document}/source{path.suffix}",
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "size_bytes": path.stat().st_size, "extension": path.suffix})


def extract(path, directory):
    directory.mkdir(exist_ok=True)
    manifest = process_local(path, directory, request_for(path))
    records = []
    for artifact in manifest.artifacts:
        compressed = (directory / artifact.name).read_bytes()
        assert hashlib.sha256(compressed).hexdigest() == artifact.sha256
        content = gzip.decompress(compressed)
        assert len(content) == artifact.uncompressed_bytes <= 4_194_304
        lines = content.splitlines()
        assert len(lines) == artifact.records <= 50
        records.extend(json.loads(line) for line in lines)
    return manifest, records


@pytest.fixture(scope="module")
def processing_fixtures(tmp_path_factory):
    directory = tmp_path_factory.mktemp("processing")
    image = text_image()
    for extension, format_name in [("jpg", "JPEG"), ("jpeg", "JPEG"), ("png", "PNG")]:
        image.save(directory / ("invoice." + extension), format=format_name)
    for extension in ["tif", "tiff"]:
        image.save(directory / ("invoice." + extension), format="TIFF", save_all=True, append_images=[image])
    with pymupdf.open() as pdf:
        page = pdf.new_page()
        page.insert_text((60, 80), "Digital invoice 2026 Supplier Example Total 1250 USD", fontsize=14)
        page = pdf.new_page(width=800, height=250)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        page.insert_image(page.rect, stream=buffer.getvalue())
        pdf.new_page()
        pdf.save(directory / "mixed.pdf")
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Invoices"
    sheet.append(["Supplier", "Amount", "Missing"])
    sheet.append(["Example", 1250.25, None])
    sheet["D2"] = "=SUM(B2,10)"
    sheet["E2"] = '=HYPERLINK("https://example.invalid","Do not follow")'
    other = workbook.create_sheet("বাংলা")
    other["B3"] = "সরবরাহকারী"
    workbook.save(directory / "invoice.xlsx")
    # Excel stores cached results; openpyxl does not calculate them. Set an explicit fixture cache.
    with zipfile.ZipFile(directory / "invoice.xlsx") as source:
        contents = {name: source.read(name) for name in source.namelist()}
    contents["xl/worksheets/sheet1.xml"] = re.sub(rb"(<f>SUM\(B2,10\)</f>)<v\s*/>", rb"\1<v>1260.25</v>", contents["xl/worksheets/sheet1.xml"])
    with zipfile.ZipFile(directory / "invoice.xlsx", "w", zipfile.ZIP_DEFLATED) as target:
        for name, content in contents.items():
            target.writestr(name, content)
    legacy = xlwt.Workbook()
    for name in ["Invoices", "Second"]:
        sheet = legacy.add_sheet(name)
        sheet.write(0, 0, "Example")
        sheet.write(0, 1, 25)
        sheet.write(1, 1, xlwt.Formula("B1+10"))
    legacy.save(str(directory / "invoice.xls"))
    return directory


def test_mixed_pdf_uses_digital_text_only_when_usable(processing_fixtures, tmp_path, monkeypatch):
    actual_ocr = processors.ocr_image
    calls = []
    def tracked(image):
        calls.append(image.size)
        return actual_ocr(image)
    monkeypatch.setattr(processors, "ocr_image", tracked)
    manifest, records = extract(processing_fixtures / "mixed.pdf", tmp_path)
    assert manifest.status == "processed"
    assert manifest.page_count == 3
    assert [page["extraction_method"] for page in records] == ["digital_text", "ocr", "none"]
    assert len(calls) == 2  # Rendered scanned and blank pages; blank page never invokes Tesseract.
    assert "Digital invoice" in records[0]["text"]
    assert "1250" in records[1]["text"]
    assert records[1]["blocks"][0]["confidence"] is not None
    assert all(0 <= block["bounding_box"][0] <= 800 for block in records[1]["blocks"])


@pytest.mark.parametrize("extension,frames", [("jpg", 1), ("jpeg", 1), ("png", 1), ("tif", 2), ("tiff", 2)])
def test_real_tesseract_all_image_formats(processing_fixtures, tmp_path, extension, frames):
    assert capabilities()["available"], "Install Tesseract to run actual OCR tests"
    manifest, records = extract(processing_fixtures / ("invoice." + extension), tmp_path)
    assert manifest.status == "processed"
    assert len(records) == frames
    for page in records:
        assert page["extraction_method"] == "ocr"
        assert "INVOICE" in page["text"] and "1250" in page["text"]
        assert 0 <= page["ocr_confidence"] <= 1
        assert page["source_reference"]["frame"] == page["page_number"]
        assert all(0 <= block["bounding_box"][0] <= block["bounding_box"][2] <= page["width"] for block in page["blocks"])


def test_xlsx_all_sheets_formulas_cached_and_missing_values(processing_fixtures, tmp_path):
    manifest, records = extract(processing_fixtures / "invoice.xlsx", tmp_path)
    assert [sheet["name"] for sheet in manifest.worksheets] == ["Invoices", "বাংলা"]
    cells = {cell["reference"]: cell for record in records if record["record_type"] == "worksheet_rows" and record["worksheet_name"] == "Invoices" for cell in record["cells"]}
    assert cells["B2"]["value"] == "1250.25"
    assert cells["C2"]["value"] is None
    assert cells["D2"]["formula"] == "=SUM(B2,10)"
    assert cells["D2"]["cached_value"] == "1260.25"
    assert cells["E2"]["formula"].startswith("=HYPERLINK")
    assert cells["E2"]["cached_value"] is None
    assert any(cell["value"] == "সরবরাহকারী" for record in records if record["record_type"] == "worksheet_rows" for cell in record["cells"])


def test_xls_all_sheets_preserves_formula_tokens(processing_fixtures, tmp_path):
    manifest, records = extract(processing_fixtures / "invoice.xls", tmp_path)
    assert manifest.status == "processed"
    assert len(manifest.worksheets) == 2
    cells = [cell for record in records if record["record_type"] == "worksheet_rows" for cell in record["cells"]]
    formulas = [cell for cell in cells if cell["value_type"] == "formula"]
    assert len(formulas) == 2
    assert formulas[0]["source_reference"]["biff_formula_tokens"]
    assert formulas[0]["formula"] in {"=B1+10", "=B1+10.0"}


@pytest.mark.parametrize("delimiter,encoding", [(";", "utf-8"), ("\t", "utf-16"), ("|", "utf-8-sig"), (",", "cp1252")])
def test_csv_delimiters_encoding_and_missing_values(tmp_path, delimiter, encoding):
    path = tmp_path / "invoice.csv"
    path.write_text(f"Supplier{delimiter}Amount{delimiter}Missing\nCafé{delimiter}1250{delimiter}\n", encoding=encoding)
    # Ingestion validation and actual extraction must accept the same CSV dialect.
    assert inspect_file(path, ".csv", InspectionLimits())["kind"] == "csv"
    manifest, records = extract(path, tmp_path / "results")
    assert manifest.status == "processed"
    assert records[0]["source_reference"]["delimiter"] == delimiter
    cells = [cell for record in records if record["record_type"] == "worksheet_rows" for cell in record["cells"]]
    assert next(cell for cell in cells if cell["reference"] == "C2")["value"] is None


def test_large_csv_streams_rows_and_bounds_artifacts(tmp_path, monkeypatch):
    path = tmp_path / "large.csv"
    with path.open("w") as target:
        target.write("id,value,missing\n")
        for number in range(10_000):
            target.write(f"{number},fixture,\n")
    request = request_for(path)
    original = Path.read_bytes
    def no_source_read_bytes(self):
        if self == path:
            raise AssertionError("CSV must stream")
        return original(self)
    monkeypatch.setattr(Path, "read_bytes", no_source_read_bytes)
    output = tmp_path / "results"
    output.mkdir()
    manifest = process_local(path, output, request)
    assert len(manifest.artifacts) >= 2
    records = [json.loads(line) for artifact in manifest.artifacts for line in gzip.decompress((output / artifact.name).read_bytes()).splitlines()]
    cells = [record for record in records if record["record_type"] == "worksheet_rows"]
    assert all(len(record["cells"]) <= 500 for record in cells)
    assert sum(len(record["cells"]) for record in cells) == 30_003


def test_page_errors_preserve_digital_neighbors(processing_fixtures, tmp_path, monkeypatch):
    def broken(_):
        raise ProcessingError("OCR_TIMEOUT")
    monkeypatch.setattr(processors, "ocr_image", broken)
    manifest, records = extract(processing_fixtures / "mixed.pdf", tmp_path)
    assert manifest.status == "partially_processed" and manifest.error_count == 2
    assert records[0]["text"].startswith("Digital invoice")
    assert records[1]["error_code"] == "OCR_TIMEOUT"


def test_missing_tesseract_is_reported_not_fabricated(processing_fixtures, tmp_path, monkeypatch):
    monkeypatch.setenv("TESSERACT_CMD", "/nonexistent/tesseract")
    assert not capabilities()["available"]
    manifest, records = extract(processing_fixtures / "invoice.png", tmp_path)
    assert manifest.status == "failed"
    assert records[0]["text"] == "" and records[0]["error_code"] == "TESSERACT_NOT_INSTALLED"


def test_missing_language_report_and_explicit_failure(processing_fixtures, tmp_path, monkeypatch):
    monkeypatch.setenv("OCR_LANGUAGES", "not_installed")
    assert capabilities()["missing_languages"] == ["not_installed"]
    manifest, records = extract(processing_fixtures / "invoice.png", tmp_path)
    assert manifest.status == "failed" and records[0]["error_code"] == "OCR_LANGUAGE_DATA_MISSING"


def test_preprocessing_inverse_and_skew(tmp_path):
    image = text_image().rotate(4, fillcolor="white")
    prepared, inverse, metadata = preprocess(image, 90)
    assert prepared.ndim == 2 and inverse.shape == (3, 3)
    assert metadata["rotation_degrees"] == 90
    assert np.isfinite(inverse).all()


def test_pdf_table_extraction(tmp_path):
    path = tmp_path / "table.pdf"
    with pymupdf.open() as pdf:
        page = pdf.new_page()
        for x in [50, 250, 450]:
            page.draw_line((x, 50), (x, 150))
        for y in [50, 100, 150]:
            page.draw_line((50, y), (450, y))
        page.insert_text((60, 80), "Description")
        page.insert_text((260, 80), "Amount")
        page.insert_text((60, 130), "Fixture")
        page.insert_text((260, 130), "1250")
        pdf.save(path)
    _, records = extract(path, tmp_path / "results")
    tables = [block for block in records[0]["blocks"] if block["block_type"] == "table"]
    assert tables and tables[0]["table_data"][1][1] == "1250"


def test_processing_child_timeout_is_bounded(processing_fixtures, tmp_path):
    path = processing_fixtures / "mixed.pdf"
    with pytest.raises(ProcessingError, match="DOCUMENT_PROCESSING_TIMEOUT"):
        process_isolated(path, tmp_path, request_for(path), ProcessingLimits(timeout_seconds=0.001))


def test_internal_auth_capabilities_and_embedding_input_validation(monkeypatch):
    monkeypatch.setenv("PROCESSOR_INTERNAL_TOKEN", "test-only-internal-processor-token")
    headers = {"authorization": "Bearer test-only-internal-processor-token"}
    with TestClient(app) as client:
        assert client.post("/internal/process", json={}).status_code == 401
        assert client.get("/internal/capabilities").status_code == 401
        assert client.get("/internal/artifacts/a/b/c/manifest.json").status_code == 401
        response = client.get("/internal/capabilities", headers=headers)
        assert response.status_code == 200 and "missing_languages" in response.json()["ocr"]
        assert client.post("/internal/embeddings", headers=headers).status_code == 422
        assert client.post("/internal/process", headers=headers, json={}).status_code == 422
        assert client.post("/internal/process", headers=headers, content=b"x" * 16_385).status_code == 413


def test_source_cannot_escape_document_prefix(processing_fixtures):
    request = request_for(processing_fixtures / "invoice.png").model_dump(mode="json")
    request["source"]["key"] = "../other-tenant/source.png"
    with pytest.raises(ValueError):
        ProcessRequest.model_validate(request)


def test_exif_orientation_correction(tmp_path):
    image = text_image()
    exif = Image.Exif()
    exif[274] = 6
    path = tmp_path / "rotated.jpg"
    image.rotate(90, expand=True).save(path, exif=exif)
    manifest, records = extract(path, tmp_path / "results")
    assert manifest.status == "processed"
    assert records[0]["width"] == 1600 and records[0]["height"] == 500
    assert records[0]["source_reference"]["exif_orientation"] == 6
    assert "INVOICE" in records[0]["text"]


def test_thousand_page_pdf_has_bounded_shards(tmp_path):
    path = tmp_path / "many.pdf"
    with pymupdf.open() as document:
        for number in range(1000):
            document.new_page().insert_text((50, 70), f"Digital page number {number + 1}")
        document.save(path)
    output = tmp_path / "results"
    output.mkdir()
    manifest = process_local(path, output, request_for(path))
    assert manifest.page_count == 1000 and manifest.status == "processed"
    assert len(manifest.artifacts) == 20
    assert all(part.records <= 50 and part.uncompressed_bytes <= 4_194_304 for part in manifest.artifacts)
    # Read one shard at a time instead of materializing every page.
    assert sum(sum(1 for _ in gzip.open(output / part.name, "rt")) for part in manifest.artifacts) == 1000


def test_corrupt_and_encrypted_processing_are_rejected(tmp_path):
    corrupt = tmp_path / "bad.pdf"
    corrupt.write_bytes(b"%PDF-1.7\ncorrupt\n%%EOF")
    with pytest.raises(ProcessingError, match="CORRUPT_FILE"):
        process_local(corrupt, tmp_path, request_for(corrupt))
    encrypted = tmp_path / "private.pdf"
    with pymupdf.open() as document:
        document.new_page()
        document.save(encrypted, encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="user")
    with pytest.raises(ProcessingError, match="ENCRYPTED_FILE_UNSUPPORTED"):
        process_local(encrypted, tmp_path, request_for(encrypted))


def test_output_limits_are_explicit(processing_fixtures, tmp_path):
    path = processing_fixtures / "invoice.png"
    with pytest.raises(ProcessingError, match="EXTRACTION_OUTPUT_LIMIT_EXCEEDED"):
        process_local(path, tmp_path, request_for(path), ProcessingLimits(total_bytes=10))


def test_unknown_formula_text_preserves_attributes_without_inventing_a_value(tmp_path):
    from openpyxl.worksheet.formula import DataTableFormula
    workbook = openpyxl.Workbook()
    workbook.active["A1"] = DataTableFormula(ref="A1:A2", r1="B1")
    path = tmp_path / "formula.xlsx"
    workbook.save(path)
    manifest, records = extract(path, tmp_path / "results")
    cell = next(record for record in records if record["record_type"] == "worksheet_rows")["cells"][0]
    assert cell["value"] is None and cell["formula"] is None
    assert cell["source_reference"]["formula_attributes"]["ref"] == "A1:A2"
    assert "FORMULA_TEXT_UNAVAILABLE" in manifest.warnings


def test_csv_binary_after_detection_sample_is_rejected(tmp_path):
    path = tmp_path / "hidden.csv"
    path.write_text("name,value\n" + "example,1234\n" * 6000 + "bad,\x00\n")
    with pytest.raises(Exception, match="SIGNATURE_MISMATCH"):
        inspect_file(path, ".csv", InspectionLimits())
