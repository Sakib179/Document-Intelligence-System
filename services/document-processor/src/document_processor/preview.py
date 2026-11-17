"""Render one bounded original page/frame; no OCR, macros or model inference."""
import hashlib
from io import BytesIO
import os
from tempfile import NamedTemporaryFile
import time

from PIL import Image, ImageOps
from pydantic import Field
from .engine import storage_client
from .inspection import InspectionLimits
from .models import ProcessRequest, ProcessingError


class PreviewRequest(ProcessRequest):
    page_number: int = Field(default=1, ge=1, le=10000)


def render_preview(request: PreviewRequest):
    source = request.source
    if source.bucket != os.environ["S3_BUCKET"] or source.size_bytes > InspectionLimits.from_environment().max_bytes:
        raise ProcessingError("PREVIEW_SOURCE_REJECTED", 403)
    if source.extension not in {".pdf", ".jpg", ".jpeg", ".png", ".tif", ".tiff"}:
        raise ProcessingError("PREVIEW_FORMAT_UNSUPPORTED", 415)
    result = storage_client().get_object(Bucket=source.bucket, Key=source.key)
    body = result["Body"]
    try:
        with NamedTemporaryFile(prefix="document-preview-", suffix=source.extension) as file:
            size, digest, deadline = 0, hashlib.sha256(), time.monotonic() + 30
            for chunk in body.iter_chunks(chunk_size=65536):
                size += len(chunk)
                if size > source.size_bytes or time.monotonic() > deadline:
                    raise ProcessingError("PREVIEW_DOWNLOAD_LIMIT", 413)
                digest.update(chunk)
                file.write(chunk)
            if size != source.size_bytes or digest.hexdigest() != source.sha256:
                raise ProcessingError("OBJECT_CHECKSUM_MISMATCH")
            file.seek(0)
            if source.extension == ".pdf":
                import pymupdf
                file.flush()
                with pymupdf.open(file.name) as pdf:
                    if pdf.needs_pass or request.page_number > len(pdf):
                        raise ProcessingError("PREVIEW_PAGE_UNAVAILABLE", 404)
                    page = pdf[request.page_number - 1]
                    scale = min(1600 / max(page.rect.width, 1), 1600 / max(page.rect.height, 1), 2)
                    return page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes("png")
            with Image.open(file) as original:
                original.seek(request.page_number - 1)
                if original.width * original.height > 40000000:
                    raise ProcessingError("PREVIEW_PIXEL_LIMIT", 413)
                image = ImageOps.exif_transpose(original).convert("RGB")
                image.thumbnail((1600, 1600))
                output = BytesIO()
                image.save(output, format="PNG")
                return output.getvalue()
    except ProcessingError:
        raise
    except (OSError, ValueError, EOFError) as error:
        raise ProcessingError("PREVIEW_PAGE_UNAVAILABLE", 422) from error
    finally:
        body.close()
