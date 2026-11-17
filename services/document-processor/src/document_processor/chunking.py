"""Structure-aware chunks, counted with one pinned reference tokenizer for both benchmarks."""
from collections import Counter
from functools import lru_cache
import re
from uuid import UUID
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from .embedding_models import QWEN_ID, QWEN_REVISION, cache_directory
from .embeddings import EmbeddingError


class ChunkUnit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    unit_id: str = Field(min_length=1, max_length=120)
    invoice_id: UUID | None = None
    page_number: int = Field(ge=1)
    worksheet: str | None = Field(default=None, max_length=255)
    cell_range: str | None = Field(default=None, max_length=128)
    section: str = Field(default="Document", max_length=300)
    kind: Literal["text", "table_row", "header"] = "text"
    text: str = Field(min_length=1, max_length=20000)


class ChunkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: UUID
    document_id: UUID
    target_tokens: int = Field(default=450, ge=100, le=600)
    maximum_tokens: int = Field(default=600, ge=100, le=1000)
    units: list[ChunkUnit] = Field(min_length=1, max_length=500)


@lru_cache(maxsize=1)
def reference_tokenizer():
    from transformers import AutoTokenizer
    try:
        return AutoTokenizer.from_pretrained(QWEN_ID, revision=QWEN_REVISION, cache_dir=cache_directory(), local_files_only=True, trust_remote_code=False)
    except Exception as error:
        raise EmbeddingError("CHUNK_TOKENIZER_NOT_AVAILABLE_LOCALLY") from error


def structure_chunks(request: ChunkRequest, tokenizer=None):
    if request.target_tokens > request.maximum_tokens:
        raise EmbeddingError("INVALID_CHUNK_LIMITS", 422)
    tokenizer = tokenizer or reference_tokenizer()
    count = lambda text: len(tokenizer.encode(text, add_special_tokens=False))
    headers = Counter(unit.text.strip().casefold() for unit in request.units if unit.kind == "header")
    seen_headers = set()
    chunks, texts, refs, key = [], [], [], None

    def flush():
        nonlocal texts, refs
        if texts:
            text = "\n".join(texts)
            chunks.append({"chunk_text": text, "token_count": count(text), "invoice_id": str(key[0]) if key[0] else None,
                "page_number": key[1], "worksheet": key[2], "section": key[3], "source_references": refs})
            texts, refs = [], []

    for unit in request.units:
        normalized = unit.text.strip().casefold()
        if re.fullmatch(r"page\s+\d+(?:\s+(?:of|/)\s*\d+)?", normalized) or normalized in {"thank you for your business", "thank you for your business."}:
            continue
        if unit.kind == "header" and headers[normalized] > 1:
            if normalized in seen_headers:
                continue
            seen_headers.add(normalized)
        next_key = (unit.invoice_id, unit.page_number, unit.worksheet, unit.section)
        if next_key != key:
            flush()
            key = next_key
        remaining, offset = unit.text.strip(), 0
        while remaining:
            # Split only overlong units; binary-search character boundaries avoids broken Bengali UTF-8.
            end = len(remaining)
            if count(remaining) > request.maximum_tokens:
                low, high = 1, len(remaining)
                while low < high:
                    middle = (low + high + 1) // 2
                    if count(remaining[:middle]) <= request.maximum_tokens:
                        low = middle
                    else:
                        high = middle - 1
                end = low
                boundary = max(remaining.rfind(" ", 0, end), remaining.rfind("\n", 0, end))
                if boundary > end // 2:
                    end = boundary
            piece = remaining[:end].strip()
            if not piece or count(piece) > request.maximum_tokens:
                raise EmbeddingError("CHUNK_UNIT_CANNOT_FIT", 422)
            if texts and count("\n".join(texts + [piece])) > request.maximum_tokens:
                flush()
            texts.append(piece)
            refs.append({"unit_id": unit.unit_id, "page_number": unit.page_number, "worksheet": unit.worksheet,
                "cell_range": unit.cell_range, "section": unit.section, "character_offset": offset, "fragment": end < len(remaining) or offset > 0})
            offset += end
            remaining = remaining[end:].lstrip()
            if count("\n".join(texts)) >= request.target_tokens or remaining:
                flush()
    flush()
    return {"chunker_version": "structure-qwen-tokenizer-v1", "tokenizer_model": QWEN_ID, "tokenizer_version": QWEN_REVISION,
        "chunks": chunks}
