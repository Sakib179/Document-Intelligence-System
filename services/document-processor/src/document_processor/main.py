"""Authenticated document processing and private bounded artifact retrieval."""

from datetime import datetime, timezone
from typing import Literal
import asyncio
import hmac
import os
from pathlib import Path
import re
from uuid import UUID

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from botocore.exceptions import BotoCoreError, ClientError
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict

from .inspection import InspectionError, InspectionLimits, inspect_upload
from .engine import process_stored, storage_client
from .models import Manifest, ProcessRequest, ProcessingError
from .ocr import capabilities
from .embeddings import EmbedRequest, EmbeddingError, generate_embeddings, embedding_capabilities
from .chunking import ChunkRequest, structure_chunks
from .preview import PreviewRequest, render_preview
from fastapi.responses import Response


class CheckResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["ok", "error"]


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    service: Literal["document-processor"] = "document-processor"
    status: Literal["ok", "error"] = "ok"
    timestamp: datetime
    checks: dict[str, CheckResult] | None = None


app = FastAPI(
    title="Document Processor",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

inspection_slots = asyncio.Semaphore(2)
processing_slots = asyncio.Semaphore(2)
embedding_slots = asyncio.Semaphore(1)
preview_slots = asyncio.Semaphore(2)


@app.post("/internal/preview")
async def document_preview(request: PreviewRequest):
    if preview_slots.locked():
        return JSONResponse({"error": {"code": "PREVIEW_BUSY"}}, status_code=503, headers={"Retry-After": "2"})
    async with preview_slots:
        try:
            data = await run_in_threadpool(render_preview, request)
            return Response(data, media_type="image/png", headers={"Cache-Control": "no-store"})
        except ClientError as error:
            status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            return JSONResponse({"error": {"code": "ORIGINAL_UNAVAILABLE"}}, status_code=404 if status == 404 else 503)


@app.middleware("http")
async def protect_internal_routes(request, call_next):
    if request.url.path.startswith("/internal/"):
        token = os.getenv("PROCESSOR_INTERNAL_TOKEN", "")
        authorization = request.headers.get("authorization", "")
        if not token:
            return JSONResponse({"error": {"code": "INSPECTOR_NOT_CONFIGURED"}}, status_code=503)
        if not hmac.compare_digest(authorization, "Bearer " + token):
            return JSONResponse({"error": {"code": "UNAUTHORIZED"}}, status_code=401)
        limit = InspectionLimits.from_environment().max_bytes + 65_536 if request.url.path == "/internal/inspect" else 1_048_576 if request.url.path in {"/internal/embeddings", "/internal/chunks"} else 16_384
        length = request.headers.get("content-length")
        if length and (not length.isdigit() or int(length) > limit):
            return JSONResponse({"error": {"code": "FILE_TOO_LARGE"}}, status_code=413)
        receive = request._receive
        consumed = 0

        async def bounded_receive():
            nonlocal consumed
            message = await receive()
            consumed += len(message.get("body", b""))
            if consumed > limit:
                raise InspectionError("FILE_TOO_LARGE", 413)
            return message

        request._receive = bounded_receive
    try:
        return await call_next(request)
    except (InspectionError, ProcessingError, EmbeddingError) as error:
        return JSONResponse({"error": {"code": error.code}}, status_code=error.status)


@app.post("/internal/inspect")
async def inspect(file: UploadFile = File(...)):
    try:
        extension = Path(file.filename or "").suffix.lower()
        async with inspection_slots:
            return await run_in_threadpool(inspect_upload, file.file, extension, InspectionLimits.from_environment())
    except InspectionError as error:
        return JSONResponse({"error": {"code": error.code}}, status_code=error.status)
    finally:
        await file.close()


@app.get("/internal/capabilities")
def processing_capabilities():
    return {"processor_version": "document-v1", "ocr": capabilities(), "embeddings": embedding_capabilities()}


@app.post("/internal/process", response_model=Manifest)
async def process_document(request: ProcessRequest):
    # Do not queue unlimited HTTP handlers behind local parser slots: BullMQ owns retries.
    if processing_slots.locked():
        return JSONResponse({"error": {"code": "PROCESSOR_BUSY"}}, status_code=503, headers={"Retry-After": "5"})
    async with processing_slots:
        return await run_in_threadpool(process_stored, request)


@app.get("/internal/artifacts/{tenant_id}/{document_id}/{run_id}/{name}")
def retrieve_artifact(tenant_id: UUID, document_id: UUID, run_id: UUID, name: str):
    if name != "manifest.json" and not re.fullmatch(r"part-[0-9]{5}\.jsonl\.gz", name):
        return JSONResponse({"error": {"code": "ARTIFACT_NOT_FOUND"}}, status_code=404)
    client = storage_client()
    bucket = os.environ["S3_BUCKET"]
    prefix = f"tenants/{tenant_id}/documents/{document_id}/processing/{run_id}/"
    try:
        manifest_object = client.get_object(Bucket=bucket, Key=prefix + "manifest.json")
        try:
            raw = manifest_object["Body"].read(4_194_305)
            if len(raw) > 4_194_304:
                raise ProcessingError("INVALID_ARTIFACT", 502)
            manifest = Manifest.model_validate_json(raw)
        finally:
            manifest_object["Body"].close()
        if (manifest.tenant_id, manifest.document_id, manifest.run_id) != (tenant_id, document_id, run_id):
            raise ProcessingError("INVALID_ARTIFACT", 502)
        if name == "manifest.json":
            client.close()
            return JSONResponse(manifest.model_dump(mode="json"))
        artifact = next((item for item in manifest.artifacts if item.name == name and item.key == prefix + name), None)
        if artifact is None:
            raise ProcessingError("ARTIFACT_NOT_FOUND", 404)
        response = client.get_object(Bucket=bucket, Key=artifact.key)
        if response["ContentLength"] != artifact.size_bytes:
            response["Body"].close()
            raise ProcessingError("INVALID_ARTIFACT", 502)
        def chunks():
            try:
                yield from response["Body"].iter_chunks(chunk_size=65_536)
            finally:
                response["Body"].close()
                client.close()
        return StreamingResponse(chunks(), media_type="application/gzip", headers={"Content-Length": str(artifact.size_bytes),
                                 "Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})
    except (ClientError, BotoCoreError) as error:
        client.close()
        status = 404 if isinstance(error, ClientError) and error.response.get("Error", {}).get("Code") in ("NoSuchKey", "404") else 503
        raise ProcessingError("ARTIFACT_NOT_FOUND" if status == 404 else "STORAGE_UNAVAILABLE", status) from error
    except Exception:
        client.close()
        raise


@app.post("/internal/embeddings")
async def embeddings(request: EmbedRequest):
    if embedding_slots.locked():
        return JSONResponse({"error": {"code": "EMBEDDER_BUSY"}}, status_code=503, headers={"Retry-After": "2"})
    async with embedding_slots:
        return await run_in_threadpool(generate_embeddings, request)


@app.post("/internal/chunks")
async def chunks(request: ChunkRequest):
    return await run_in_threadpool(structure_chunks, request)


@app.get("/health", response_model=HealthResponse, response_model_exclude_none=True)
def health() -> HealthResponse:
    return HealthResponse(timestamp=datetime.now(timezone.utc))


@app.get("/health/ready", response_model=HealthResponse, response_model_exclude_none=True)
def ready() -> HealthResponse:
    return HealthResponse(timestamp=datetime.now(timezone.utc), checks={})
