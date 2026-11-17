"""Bounded file-format inspection. No OCR, text extraction, macros, or formulas run."""

from __future__ import annotations

import multiprocessing
import os
import posixpath
import tempfile
import warnings
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath

import pymupdf
import xlrd
from defusedxml import ElementTree
from PIL import Image

from .csv_reader import csv_format, csv_rows
from .models import ProcessingError


@dataclass(frozen=True)
class InspectionLimits:
    max_bytes: int = 52_428_800
    max_pages: int = 1_000
    max_image_pixels: int = 40_000_000
    max_total_pixels: int = 200_000_000
    max_zip_bytes: int = 134_217_728
    max_zip_entries: int = 10_000
    max_xml_bytes: int = 4_194_304
    timeout_seconds: float = 30

    @classmethod
    def from_environment(cls) -> InspectionLimits:
        return cls(
            max_bytes=int(os.getenv("UPLOAD_MAX_FILE_BYTES", "52428800")),
            max_pages=int(os.getenv("UPLOAD_MAX_PAGES", "1000")),
            timeout_seconds=int(os.getenv("INSPECTION_TIMEOUT_MS", "30000")) / 1000,
        )


class InspectionError(Exception):
    def __init__(self, code: str, status: int = 422):
        super().__init__(code)
        self.code = code
        self.status = status


MIMES = {
    ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".tif": "image/tiff", ".tiff": "image/tiff",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel", ".csv": "text/csv",
}


def _check_count(count: int, limits: InspectionLimits) -> None:
    if count < 1:
        raise InspectionError("EMPTY_DOCUMENT")
    if count > limits.max_pages:
        raise InspectionError("PAGE_LIMIT_EXCEEDED", 413)


def _inspect_xlsx(path: Path, limits: InspectionLimits) -> list[str]:
    # Never extract an archive to disk or follow external relationships.
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) > limits.max_zip_entries or sum(item.file_size for item in members) > limits.max_zip_bytes:
            raise InspectionError("ARCHIVE_LIMIT_EXCEEDED", 413)
        names = [item.filename for item in members]
        if len(names) != len(set(names)):
            raise InspectionError("CORRUPT_FILE")
        for item in members:
            member = PurePosixPath(item.filename)
            if member.is_absolute() or ".." in member.parts or "\\" in item.filename or "\x00" in item.filename:
                raise InspectionError("UNSAFE_ARCHIVE")
            if item.flag_bits & 1:
                raise InspectionError("ENCRYPTED_FILE_UNSUPPORTED")
            if item.file_size > max(1, item.compress_size) * 200:
                raise InspectionError("ARCHIVE_LIMIT_EXCEEDED", 413)
            if "vbaproject" in item.filename.lower():
                raise InspectionError("MACRO_WORKBOOK_UNSUPPORTED")
        required = {"[Content_Types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"}
        if not required.issubset(names):
            raise InspectionError("SIGNATURE_MISMATCH", 415)
        if archive.testzip() is not None:
            raise InspectionError("CORRUPT_FILE")

        def xml(name: str):
            if archive.getinfo(name).file_size > limits.max_xml_bytes:
                raise InspectionError("ARCHIVE_LIMIT_EXCEEDED", 413)
            return ElementTree.fromstring(archive.read(name))

        types = xml("[Content_Types].xml")
        workbook_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
        if not any(node.attrib.get("ContentType") == workbook_type and node.attrib.get("PartName") == "/xl/workbook.xml" for node in types):
            raise InspectionError("SIGNATURE_MISMATCH", 415)
        workbook = xml("xl/workbook.xml")
        main_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        if workbook.tag != "{" + main_ns + "}workbook":
            raise InspectionError("CORRUPT_FILE")
        relationships = {node.attrib.get("Id"): node.attrib for node in xml("xl/_rels/workbook.xml.rels")}
        sheets = workbook.findall("{" + main_ns + "}sheets/{" + main_ns + "}sheet")
        _check_count(len(sheets), limits)
        sheet_names: list[str] = []
        for sheet in sheets:
            name = sheet.attrib.get("name", "")
            relation = relationships.get(sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"))
            if not name or len(name) > 255 or not relation or relation.get("TargetMode") == "External":
                raise InspectionError("CORRUPT_FILE")
            target = relation.get("Target", "")
            normalized = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
            if not normalized.startswith("xl/") or normalized not in names:
                raise InspectionError("CORRUPT_FILE")
            # Reject malformed worksheet XML without evaluating cells or formulas.
            if archive.getinfo(normalized).file_size <= limits.max_xml_bytes:
                xml(normalized)
            else:
                with archive.open(normalized) as worksheet:
                    for _, element in ElementTree.iterparse(worksheet, events=("end",)):
                        element.clear()
            sheet_names.append(name)
        if len(sheet_names) != len(set(sheet_names)):
            raise InspectionError("CORRUPT_FILE")
        return sheet_names


def inspect_file(path: Path, extension: str, limits: InspectionLimits) -> dict:
    if extension not in MIMES:
        raise InspectionError("UNSUPPORTED_EXTENSION", 415)
    if not path.stat().st_size:
        raise InspectionError("EMPTY_FILE")
    if path.stat().st_size > limits.max_bytes:
        raise InspectionError("FILE_TOO_LARGE", 413)
    with path.open("rb") as source:
        signature = source.read(16)
    result = {"pageCount": 1, "mimeType": MIMES[extension], "kind": "image", "worksheetNames": [], "warnings": []}
    try:
        if extension == ".pdf":
            if not signature.startswith(b"%PDF-"):
                raise InspectionError("SIGNATURE_MISMATCH", 415)
            with path.open("rb") as source:
                source.seek(max(0, path.stat().st_size - 2048))
                if not source.read().rstrip(b" \r\n\t\x00").endswith(b"%%EOF"):
                    raise InspectionError("CORRUPT_FILE")
            with pymupdf.open(path) as document:
                if not document.is_pdf:
                    raise InspectionError("SIGNATURE_MISMATCH", 415)
                if document.needs_pass:
                    raise InspectionError("ENCRYPTED_FILE_UNSUPPORTED")
                result["pageCount"] = document.page_count
                if document.is_repaired:
                    result["warnings"].append("PDF_REPAIRED")
            result["kind"] = "pdf"
        elif extension in {".jpg", ".jpeg", ".png", ".tiff", ".tif"}:
            expected = "JPEG" if extension in {".jpg", ".jpeg"} else "PNG" if extension == ".png" else "TIFF"
            magic_ok = (expected == "JPEG" and signature.startswith(b"\xff\xd8\xff")) or (expected == "PNG" and signature.startswith(b"\x89PNG\r\n\x1a\n")) or (expected == "TIFF" and signature[:4] in {b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+"})
            if not magic_ok:
                raise InspectionError("SIGNATURE_MISMATCH", 415)
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(path) as image:
                    if image.format != expected:
                        raise InspectionError("SIGNATURE_MISMATCH", 415)
                    result["pageCount"] = getattr(image, "n_frames", 1)
                    _check_count(result["pageCount"], limits)
                    total_pixels = 0
                    for index in range(result["pageCount"]):
                        image.seek(index)
                        pixels = image.width * image.height
                        total_pixels += pixels
                        if pixels > limits.max_image_pixels or total_pixels > limits.max_total_pixels:
                            raise InspectionError("IMAGE_PIXEL_LIMIT_EXCEEDED", 413)
                        image.load()
        elif extension == ".xlsx":
            if not signature.startswith(b"PK\x03\x04"):
                raise InspectionError("SIGNATURE_MISMATCH", 415)
            result["worksheetNames"] = _inspect_xlsx(path, limits)
            result["pageCount"] = len(result["worksheetNames"])
            result["kind"] = "spreadsheet"
        elif extension == ".xls":
            if not signature.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
                raise InspectionError("SIGNATURE_MISMATCH", 415)
            workbook = xlrd.open_workbook(filename=str(path), on_demand=True)
            try:
                result["pageCount"] = workbook.nsheets
                result["worksheetNames"] = workbook.sheet_names()
            finally:
                workbook.release_resources()
            result["kind"] = "spreadsheet"
        else:
            # CSV has no magic bytes: validate encoding, textual content, and CSV structure.
            _, _, csv_warnings = csv_format(path)
            result["warnings"].extend(csv_warnings)
            rows = 0
            for _, _ in csv_rows(path):
                rows += 1
            if not rows:
                raise InspectionError("EMPTY_FILE")
            result["kind"] = "csv"
        _check_count(result["pageCount"], limits)
        return result
    except InspectionError:
        raise
    except ProcessingError as error:
        raise InspectionError(error.code, error.status) from error
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise InspectionError("IMAGE_PIXEL_LIMIT_EXCEEDED", 413) from error
    except Exception as error:
        raise InspectionError("CORRUPT_FILE") from error


def _inspection_child(connection, path: str, extension: str, options: dict) -> None:
    try:
        connection.send({"result": inspect_file(Path(path), extension, InspectionLimits(**options))})
    except InspectionError as error:
        connection.send({"error": error.code, "status": error.status})
    except BaseException:
        connection.send({"error": "CORRUPT_FILE", "status": 422})
    finally:
        connection.close()


def inspect_in_process(path: Path, extension: str, limits: InspectionLimits) -> dict:
    # Spawn uses sys.executable: the existing Python Work interpreter, not a new environment.
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_inspection_child, args=(sender, str(path), extension, asdict(limits)))
    process.start()
    sender.close()
    try:
        if not receiver.poll(limits.timeout_seconds):
            raise InspectionError("INSPECTION_TIMEOUT", 422)
        try:
            response = receiver.recv()
        except EOFError as error:
            raise InspectionError("CORRUPT_FILE") from error
        if "error" in response:
            raise InspectionError(response["error"], response["status"])
        return response["result"]
    finally:
        receiver.close()
        if process.is_alive():
            process.terminate()
        process.join(timeout=2)
        if process.is_alive():
            process.kill()
            process.join()


def inspect_upload(source, extension: str, limits: InspectionLimits) -> dict:
    with tempfile.TemporaryDirectory(prefix="document-inspect-") as directory:
        path = Path(directory) / "source"
        size = 0
        with path.open("xb") as target:
            while chunk := source.read(65_536):
                size += len(chunk)
                if size > limits.max_bytes:
                    raise InspectionError("FILE_TOO_LARGE", 413)
                target.write(chunk)
        return inspect_in_process(path, extension, limits)
