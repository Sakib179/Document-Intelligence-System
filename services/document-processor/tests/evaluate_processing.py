"""Actual, explicitly synthetic OCR measurements; no production accuracy claims."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import tempfile
import time
from uuid import uuid4

from document_processor.engine import process_local
from document_processor.models import ProcessRequest
from document_processor.ocr import capabilities
from create_processing_fixtures import REFERENCE_TEXT, create_fixtures, text_image


def distance(reference, predicted):
    previous = list(range(len(predicted) + 1))
    for row, expected in enumerate(reference, 1):
        current = [row]
        for column, actual in enumerate(predicted, 1):
            current.append(min(current[-1] + 1, previous[column] + 1, previous[column - 1] + (expected != actual)))
        previous = current
    return previous[-1]


def normalize(text):
    return " ".join(re.findall(r"\w+", text.casefold()))


def evaluate(output: Path):
    available = capabilities()
    if not available["available"] or "eng" not in available["active_languages"]:
        raise RuntimeError("Real Tesseract with English language data is required for this evaluation")
    samples, started = [], time.monotonic()
    with tempfile.TemporaryDirectory(prefix="processor-evaluation-") as name:
        directory = Path(name)
        create_fixtures(directory)
        image = text_image()
        for extension, format_name in [("jpg", "JPEG"), ("jpeg", "JPEG"), ("png", "PNG"), ("tif", "TIFF"), ("tiff", "TIFF")]:
            image.save(directory / ("ocr." + extension), format=format_name, **({"save_all": True, "append_images": [image]} if format_name == "TIFF" else {}))
        for filename in ["ocr.jpg", "ocr.jpeg", "ocr.png", "ocr.tif", "ocr.tiff", "process.pdf"]:
            source = directory / filename
            tenant, document = uuid4(), uuid4()
            request = ProcessRequest(tenant_id=tenant, document_id=document, run_id=uuid4(), source={
                "bucket": "evaluation-only", "key": f"tenants/{tenant}/documents/{document}/source{source.suffix}",
                "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "size_bytes": source.stat().st_size, "extension": source.suffix})
            destination = directory / (filename + "-results")
            destination.mkdir()
            manifest = process_local(source, destination, request)
            if manifest.status != "processed":
                raise RuntimeError("Evaluation processing failed: " + filename)
            for artifact in manifest.artifacts:
                with gzip.open(destination / artifact.name, "rt") as lines:
                    for line in lines:
                        page = json.loads(line)
                        if page.get("extraction_method") != "ocr":
                            continue
                        expected, predicted = normalize(REFERENCE_TEXT), normalize(page["text"])
                        samples.append({"fixture": filename, "page": page["page_number"], "source_sha256": request.source.sha256,
                            "reference_text": REFERENCE_TEXT, "recognized_text": page["text"],
                            "word_errors": distance(expected.split(), predicted.split()), "reference_words": len(expected.split()),
                            "character_errors": distance(expected, predicted), "reference_characters": len(expected),
                            "mean_ocr_confidence": page["ocr_confidence"]})
    words, chars = sum(item["reference_words"] for item in samples), sum(item["reference_characters"] for item in samples)
    report = {"evaluation": "synthetic-printed-English-v1", "measured_at": datetime.now(timezone.utc).isoformat(),
        "scope": "Eight clean synthetic OCR pages from the same printed fixture across image formats and a scanned PDF; no real-world accuracy estimate.",
        "normalization": "Unicode word characters, casefolded, whitespace collapsed; edit distance includes substitutions/deletions/insertions.",
        "ocr_capabilities": available, "sample_count": len(samples), "word_error_rate": sum(item["word_errors"] for item in samples) / words,
        "character_error_rate": sum(item["character_errors"] for item in samples) / chars,
        "elapsed_seconds": round(time.monotonic() - started, 3), "bangla_evaluated": False,
        "bangla_reason": "No Bangla OCR ground-truth fixture is included; missing language packs are reported in capabilities.", "samples": samples}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "sample_count": len(samples), "word_error_rate": report["word_error_rate"], "character_error_rate": report["character_error_rate"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    evaluate(parser.parse_args().output)
