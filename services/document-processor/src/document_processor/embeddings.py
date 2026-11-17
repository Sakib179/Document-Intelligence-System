"""Local-only Transformers adapters following each official model card."""
from collections import OrderedDict
from hashlib import sha256
import os
import threading
import time
from uuid import UUID
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictStr
from .embedding_models import QWEN_ID, QWEN_REVISION, DEFAULT_INSTRUCTION, ModelSpec, cache_directory, model_spec, query_text


class EmbeddingError(Exception):
    def __init__(self, code: str, status: int = 503):
        self.code, self.status = code, status
        super().__init__(code)


class EmbedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: UUID
    model_id: str
    model_version: str
    dimensions: int = Field(default=1024, ge=32, le=1024)
    kind: Literal["document", "query"]
    texts: list[StrictStr] = Field(min_length=1, max_length=16)
    query_instruction: str = Field(default=DEFAULT_INSTRUCTION, min_length=1, max_length=500)


class EmbeddingEngine:
    def __init__(self, spec: ModelSpec, dimensions: int = 1024, maximum_tokens: int = 2048, cache_size: int = 1024):
        if dimensions < 32 or dimensions > 1024 or (not spec.matryoshka and dimensions != 1024):
            raise EmbeddingError("UNSUPPORTED_EMBEDDING_DIMENSIONS", 422)
        self.spec, self.dimensions, self.maximum_tokens = spec, dimensions, maximum_tokens
        self.cache_size = cache_size
        self.cache = OrderedDict()
        self.lock = threading.Lock()
        self.model = self.tokenizer = None
        self.load_ms = None

    def load(self):
        if self.model is not None:
            return
        import torch
        from transformers import AutoModel, AutoTokenizer
        started = time.perf_counter()
        torch.set_num_threads(int(os.getenv("EMBEDDING_CPU_THREADS", "4")))
        try:
            self.tokenizer = AutoTokenizer.from_pretrained(self.spec.model_id, revision=self.spec.revision,
                cache_dir=cache_directory(), local_files_only=True, trust_remote_code=False, padding_side="left")
            self.model = AutoModel.from_pretrained(self.spec.model_id, revision=self.spec.revision,
                cache_dir=cache_directory(), local_files_only=True, trust_remote_code=False,
                dtype=torch.float32, attn_implementation="sdpa").to("cpu").eval()
        except Exception as error:
            self.model = self.tokenizer = None
            raise EmbeddingError("EMBEDDING_MODEL_NOT_AVAILABLE_LOCALLY") from error
        self.load_ms = round((time.perf_counter() - started) * 1000, 3)

    def encode(self, texts: list[str], kind: str, instruction: str, tenant: str):
        if not texts or len(texts) > 16 or any(not text.strip() or len(text) > 8000 for text in texts):
            raise EmbeddingError("INVALID_EMBEDDING_INPUT", 422)
        started = time.perf_counter()
        with self.lock:
            self.load()
            import torch
            import torch.nn.functional as functional
            formatted = [query_text(self.spec, instruction, text) if kind == "query" else text for text in texts]
            keys = [(tenant, kind, sha256(text.encode()).hexdigest()) for text in formatted]
            missing = list(dict.fromkeys(key for key in keys if key not in self.cache))
            values = {}
            if missing:
                inputs = [formatted[keys.index(key)] for key in missing]
                lengths = self.tokenizer(inputs, padding=False, truncation=False)["input_ids"]
                if any(len(tokens) > self.maximum_tokens for tokens in lengths):
                    raise EmbeddingError("EMBEDDING_INPUT_TOO_LONG", 422)
                batch = self.tokenizer(inputs, padding=True, truncation=False, return_tensors="pt")
                with torch.inference_mode():
                    output = self.model(**batch)
                    # Left padding puts the last non-padding token at the final position.
                    pooled = output.last_hidden_state[:, -1, :self.dimensions]
                    vectors = functional.normalize(pooled, p=2, dim=1).float().cpu()
                if not torch.isfinite(vectors).all() or (vectors.norm(dim=1) < 0.999).any():
                    raise EmbeddingError("INVALID_EMBEDDING_OUTPUT", 502)
                for key, vector in zip(missing, vectors.tolist()):
                    values[key] = vector
                    self.cache[key] = vector
            result = []
            hits = 0
            for key in keys:
                if key not in values:
                    hits += 1
                vector = values.get(key, self.cache.get(key))
                result.append(vector)
                if key in self.cache:
                    self.cache.move_to_end(key)
            while len(self.cache) > self.cache_size:
                self.cache.popitem(last=False)
        return {"model_id": self.spec.model_id, "model_version": self.spec.revision, "dimensions": self.dimensions,
            "adapter": self.spec.adapter, "normalized": True, "vectors": result, "cache_hits": hits,
            "processing_time_ms": round((time.perf_counter() - started) * 1000, 3)}


_engine = None
_initialization = threading.Lock()


def active_engine() -> EmbeddingEngine:
    global _engine
    if os.getenv("EMBEDDINGS_ENABLED", "true") != "true":
        raise EmbeddingError("EMBEDDINGS_DISABLED")
    spec = model_spec(os.getenv("EMBEDDING_MODEL_ID", QWEN_ID), os.getenv("EMBEDDING_MODEL_VERSION", QWEN_REVISION))
    dimensions = int(os.getenv("EMBEDDING_DIMENSIONS", "1024"))
    with _initialization:
        if _engine is None:
            _engine = EmbeddingEngine(spec, dimensions, int(os.getenv("EMBEDDING_MAX_TOKENS", "2048")))
        if (_engine.spec, _engine.dimensions) != (spec, dimensions):
            raise EmbeddingError("EMBEDDING_CONFIG_RESTART_REQUIRED")
        return _engine


def generate_embeddings(request: EmbedRequest):
    engine = active_engine()
    if (request.model_id, request.model_version, request.dimensions) != (engine.spec.model_id, engine.spec.revision, engine.dimensions):
        raise EmbeddingError("EMBEDDING_SPACE_MISMATCH", 409)
    return engine.encode(request.texts, request.kind, request.query_instruction, str(request.tenant_id))


def embedding_capabilities():
    return {"enabled": os.getenv("EMBEDDINGS_ENABLED", "true") == "true", "model_id": os.getenv("EMBEDDING_MODEL_ID", QWEN_ID),
        "model_version": os.getenv("EMBEDDING_MODEL_VERSION", QWEN_REVISION), "dimensions": int(os.getenv("EMBEDDING_DIMENSIONS", "1024")),
        "loaded": _engine is not None and _engine.model is not None, "local_only": True}
