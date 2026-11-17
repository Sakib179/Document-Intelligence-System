"""Official public model identities; production loads one pinned local model only."""
from dataclasses import dataclass
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parents[4]
QWEN_ID = "Qwen/Qwen3-Embedding-0.6B"
QWEN_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
HARRIER_ID = "microsoft/harrier-oss-v1-0.6b"
HARRIER_REVISION = "f9b9dc8d367d443f2479d27aa5d8d2850c0774ee"
DEFAULT_INSTRUCTION = "Given an invoice or business document search query, retrieve relevant passages that answer the query"


@dataclass(frozen=True)
class ModelSpec:
    model_id: str
    revision: str
    adapter: str
    query_separator: str
    matryoshka: bool


def model_spec(model_id: str, revision: str) -> ModelSpec:
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("EMBEDDING_REVISION_REQUIRED")
    if model_id == QWEN_ID:
        return ModelSpec(model_id, revision, "qwen3-last-token-v1", "Query:", True)
    if model_id == HARRIER_ID:
        return ModelSpec(model_id, revision, "harrier-last-token-v1", "Query: ", False)
    raise ValueError("UNSUPPORTED_EMBEDDING_MODEL")


def cache_directory() -> str:
    configured = Path(os.getenv("EMBEDDING_CACHE_DIR", ".cache/huggingface"))
    return str(configured if configured.is_absolute() else ROOT / configured)


def query_text(spec: ModelSpec, instruction: str, text: str) -> str:
    return f"Instruct: {instruction}\n{spec.query_separator}{text}"
