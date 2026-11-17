"""Disk-backed compressed JSONL shards, isolated parsing and private S3 artifacts."""
from dataclasses import dataclass
import gzip
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import signal
import tempfile
import time

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from .inspection import InspectionError, InspectionLimits, inspect_file
from .models import Artifact, Manifest, ProcessRequest, ProcessingError
from .processors import records


@dataclass(frozen=True)
class ProcessingLimits:
    timeout_seconds: int = 600
    records_per_shard: int = 50
    shard_bytes: int = 4_194_304
    record_bytes: int = 2_097_152
    total_bytes: int = 536_870_912

    @classmethod
    def from_environment(cls):
        return cls(timeout_seconds=int(os.getenv("PROCESSING_TIMEOUT_SECONDS", "600")))


def artifact_prefix(request: ProcessRequest) -> str:
    return f"tenants/{request.tenant_id}/documents/{request.document_id}/processing/{request.run_id}/"


class ArtifactWriter:
    def __init__(self, directory: Path, request: ProcessRequest, limits: ProcessingLimits):
        self.directory, self.request, self.limits = directory, request, limits
        self.output, self.path, self.count, self.size, self.total = None, None, 0, 0, 0
        self.artifacts = []

    def write(self, record):
        envelope = {"schema_version": 1, "tenant_id": str(self.request.tenant_id), "document_id": str(self.request.document_id),
                    "run_id": str(self.request.run_id), **record}
        line = json.dumps(envelope, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8") + b"\n"
        if len(line) > self.limits.record_bytes:
            raise ProcessingError("RECORD_SIZE_LIMIT_EXCEEDED", 413)
        if self.total + len(line) > self.limits.total_bytes:
            raise ProcessingError("EXTRACTION_OUTPUT_LIMIT_EXCEEDED", 413)
        if self.output and (self.count >= self.limits.records_per_shard or self.size + len(line) > self.limits.shard_bytes):
            self.close_shard()
        if self.output is None:
            self.path = self.directory / f"part-{len(self.artifacts):05d}.jsonl.gz"
            self.output = gzip.open(self.path, "wb", compresslevel=6)
        self.output.write(line)
        self.count += 1
        self.size += len(line)
        self.total += len(line)

    def close_shard(self):
        if self.output is None:
            return
        self.output.close()
        with self.path.open("rb") as source:
            sha256 = hashlib.file_digest(source, "sha256").hexdigest()
        self.artifacts.append(Artifact(name=self.path.name, key=artifact_prefix(self.request) + self.path.name,
                                       sha256=sha256, size_bytes=self.path.stat().st_size,
                                       uncompressed_bytes=self.size, records=self.count))
        self.output, self.count, self.size = None, 0, 0


def process_local(path: Path, directory: Path, request: ProcessRequest, limits: ProcessingLimits | None = None) -> Manifest:
    """Used only inside a disposable child in the HTTP service; directly callable in tests."""
    limits = limits or ProcessingLimits.from_environment()
    try:
        inspection = inspect_file(path, request.source.extension, InspectionLimits.from_environment())
    except InspectionError as error:
        raise ProcessingError(error.code, error.status) from error
    writer = ArtifactWriter(directory, request, limits)
    pages, errors, warnings, worksheets = 0, set(), set(inspection["warnings"]), []
    def normalize(value):
        if isinstance(value, str):
            if "\x00" in value:
                warnings.add("SOURCE_NULL_CHARACTER_REPLACED")
            return value.replace("\x00", "\ufffd")
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, dict):
            return {normalize(key): normalize(item) for key, item in value.items()}
        return value
    try:
        for record in records(path, request.source.extension):
            data = normalize(record.model_dump(mode="json") if hasattr(record, "model_dump") else record)
            if data["record_type"] == "page":
                pages += 1
                warnings.update(data["warnings"])
                if data["error_code"]:
                    errors.add(data["page_number"])
                if data.get("worksheet_name"):
                    worksheets.append({"name": data["worksheet_name"], "page_number": data["page_number"]})
            elif data["record_type"] == "source_error":
                errors.add(data["page_number"])
            elif data["record_type"] == "worksheet_rows":
                if any(cell["value_type"] == "formula" and cell["formula"] is None for cell in data["cells"]):
                    warnings.add("FORMULA_TEXT_UNAVAILABLE")
            # A pathological PDF page must not discard good neighboring pages.
            try:
                writer.write(data)
            except ProcessingError as error:
                if error.code != "RECORD_SIZE_LIMIT_EXCEEDED":
                    raise
                errors.add(data["page_number"])
                if data["record_type"] == "page":
                    writer.write({**data, "text": "", "blocks": [], "error_code": error.code})
                else:
                    writer.write({"record_type": "source_error", "page_number": data["page_number"], "error_code": error.code})
    finally:
        writer.close_shard()
    if not pages:
        raise ProcessingError("EMPTY_DOCUMENT")
    status = "failed" if len(errors) == pages else "partially_processed" if errors else "processed"
    manifest = Manifest(tenant_id=request.tenant_id, document_id=request.document_id, run_id=request.run_id, source=request.source,
                        status=status, page_count=pages, error_count=len(errors), worksheets=worksheets,
                        warnings=sorted(warnings), artifacts=writer.artifacts)
    (directory / "manifest.json").write_text(manifest.model_dump_json(), encoding="utf-8")
    return manifest


def _processing_child(connection, path, directory, request, options):
    try:
        if os.name == "posix":
            os.setsid()  # Keep OCR descendants in this disposable execution's process group.
        process_local(Path(path), Path(directory), ProcessRequest.model_validate(request), ProcessingLimits(**options))
        connection.send({"ok": True})
    except (ProcessingError, InspectionError) as error:
        connection.send({"error": error.code, "status": error.status})
    except BaseException:
        connection.send({"error": "DOCUMENT_PROCESSING_FAILED", "status": 422})
    finally:
        connection.close()


def process_isolated(path, directory, request, limits):
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_processing_child, args=(sender, str(path), str(directory), request.model_dump(mode="json"), vars(limits)))
    process.start()
    sender.close()
    try:
        if not receiver.poll(limits.timeout_seconds):
            raise ProcessingError("DOCUMENT_PROCESSING_TIMEOUT", 504)
        try:
            response = receiver.recv()
        except EOFError as error:
            raise ProcessingError("DOCUMENT_PROCESSING_FAILED") from error
        if "error" in response:
            raise ProcessingError(response["error"], response["status"])
        return Manifest.model_validate_json((directory / "manifest.json").read_bytes())
    finally:
        receiver.close()
        def stop_group(sig):
            if os.name == "posix":
                try:
                    os.killpg(process.pid, sig)
                    return
                except ProcessLookupError:
                    pass  # The child may not have reached setsid during an early timeout.
            if process.is_alive():
                process.terminate() if sig == signal.SIGTERM else process.kill()
        was_alive = process.is_alive()
        if was_alive:
            stop_group(signal.SIGTERM)
        process.join(timeout=2)
        if was_alive:
            stop_group(signal.SIGKILL)
        if process.is_alive():
            process.join()


def storage_client():
    # Explicit credentials prevent accidental instance-profile probing or ambient AWS access.
    return boto3.client("s3", endpoint_url=os.environ["S3_ENDPOINT"], region_name=os.environ["S3_REGION"],
                        aws_access_key_id=os.environ["S3_ACCESS_KEY"], aws_secret_access_key=os.environ["S3_SECRET_KEY"],
                        config=Config(connect_timeout=3, read_timeout=30, retries={"total_max_attempts": 1}, s3={"addressing_style": "path"}))


def process_stored(request: ProcessRequest) -> Manifest:
    if request.source.bucket != os.environ["S3_BUCKET"]:
        raise ProcessingError("STORAGE_REFERENCE_REJECTED", 403)
    if request.source.size_bytes > InspectionLimits.from_environment().max_bytes:
        raise ProcessingError("FILE_TOO_LARGE", 413)
    limits = ProcessingLimits.from_environment()
    deadline = time.monotonic() + limits.timeout_seconds + 90
    client = storage_client()
    try:
        with tempfile.TemporaryDirectory(prefix="document-process-") as name:
            directory = Path(name)
            path = directory / ("source" + request.source.extension)
            response = client.get_object(Bucket=request.source.bucket, Key=request.source.key)
            body = response["Body"]
            try:
                if response["ContentLength"] != request.source.size_bytes:
                    raise ProcessingError("OBJECT_SIZE_MISMATCH")
                digest, size, download_deadline = hashlib.sha256(), 0, time.monotonic() + 60
                with path.open("xb") as target:
                    for chunk in body.iter_chunks(chunk_size=65_536):
                        size += len(chunk)
                        if size > request.source.size_bytes or time.monotonic() > download_deadline:
                            raise ProcessingError("OBJECT_DOWNLOAD_LIMIT_EXCEEDED")
                        digest.update(chunk)
                        target.write(chunk)
                if size != request.source.size_bytes or digest.hexdigest() != request.source.sha256:
                    raise ProcessingError("OBJECT_CHECKSUM_MISMATCH")
            finally:
                body.close()
            manifest = process_isolated(path, directory, request, limits)
            # Manifest is the commit marker. An interrupted upload leaves no retrievable manifest.
            for artifact in manifest.artifacts:
                if time.monotonic() > deadline:
                    raise ProcessingError("ARTIFACT_UPLOAD_TIMEOUT", 504)
                with (directory / artifact.name).open("rb") as content:
                    client.put_object(Bucket=request.source.bucket, Key=artifact.key, Body=content,
                                      ContentType="application/gzip", ContentLength=artifact.size_bytes,
                                      Metadata={"sha256": artifact.sha256, "document-id": str(request.document_id), "tenant-id": str(request.tenant_id)})
            if time.monotonic() > deadline:
                raise ProcessingError("ARTIFACT_UPLOAD_TIMEOUT", 504)
            client.put_object(Bucket=request.source.bucket, Key=artifact_prefix(request) + "manifest.json",
                              Body=manifest.model_dump_json().encode("utf-8"), ContentType="application/json")
            return manifest
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            raise ProcessingError("OBJECT_NOT_FOUND", 404) from error
        raise ProcessingError("STORAGE_UNAVAILABLE", 503) from error
    except BotoCoreError as error:
        raise ProcessingError("STORAGE_UNAVAILABLE", 503) from error
    finally:
        client.close()
