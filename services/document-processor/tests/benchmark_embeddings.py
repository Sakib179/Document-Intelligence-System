"""One model per subprocess; synthetic corpus only, actual inference and peak process RSS."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import threading
import time
import importlib.metadata
from uuid import uuid5, NAMESPACE_URL

import psutil
from document_processor.embedding_models import model_spec, QWEN_ID, QWEN_REVISION, HARRIER_ID, HARRIER_REVISION, DEFAULT_INSTRUCTION
from document_processor.embeddings import EmbeddingEngine
from document_processor.chunking import ChunkRequest, structure_chunks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["qwen", "harrier"], required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    raw = Path(args.dataset).read_bytes()
    dataset = json.loads(raw)
    process = psutil.Process()
    maximum_rss = [process.memory_info().rss]
    stop = threading.Event()

    def sample():
        while not stop.wait(0.05):
            maximum_rss[0] = max(maximum_rss[0], process.memory_info().rss)
    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    chunks = []
    for document in dataset["documents"]:
        request = ChunkRequest(tenant_id=uuid5(NAMESPACE_URL, "benchmark-tenant"), document_id=uuid5(NAMESPACE_URL, document["id"]),
            units=[{"unit_id": document["id"], "page_number": 1, "text": document["text"], "section": "Invoice"}])
        for index, chunk in enumerate(structure_chunks(request)["chunks"]):
            chunks.append({"id":document["id"]+":"+str(index), "document_id":document["id"], "text":chunk["chunk_text"], "token_count":chunk["token_count"]})
    spec = model_spec(QWEN_ID, QWEN_REVISION) if args.model == "qwen" else model_spec(HARRIER_ID, HARRIER_REVISION)
    engine = EmbeddingEngine(spec, cache_size=0)
    engine.load()
    document_ms, query_ms = [], []
    rows = []
    for offset in range(0, len(chunks), 4):
        batch = chunks[offset:offset+4]
        result = engine.encode([chunk["text"] for chunk in batch], "document", DEFAULT_INSTRUCTION, "synthetic-benchmark")
        document_ms.append(result["processing_time_ms"])
        rows.extend({**chunk, "vector": vector} for chunk, vector in zip(batch, result["vectors"]))
    queries = []
    for query in dataset["queries"]:
        result = engine.encode([query["text"]], "query", DEFAULT_INSTRUCTION, "synthetic-benchmark")
        query_ms.append(result["processing_time_ms"])
        queries.append({**query, "vector": result["vectors"][0]})
    stop.set(); sampler.join()
    output = {"model_id":spec.model_id,"model_version":spec.revision,"adapter":spec.adapter,"dimensions":1024,"corpus_documents":len(dataset["documents"]),
        "dataset_sha256":hashlib.sha256(raw).hexdigest(),"chunks_sha256":hashlib.sha256(json.dumps(chunks,sort_keys=True,ensure_ascii=False).encode()).hexdigest(),
        "chunker_version":"structure-qwen-tokenizer-v1","query_instruction":DEFAULT_INSTRUCTION,"device":"cpu","dtype":"float32","cpu_threads":4,
        "python":platform.python_version(),"hardware":{"architecture":platform.machine(),"processor":platform.processor(),"logical_cpus":psutil.cpu_count(),"system_ram_bytes":psutil.virtual_memory().total},"versions":{name:importlib.metadata.version(name) for name in ["torch","transformers","tokenizers"]},
        "model_load_ms":engine.load_ms,"document_batch_ms":document_ms,"query_embedding_ms":query_ms,"peak_process_rss_bytes":maximum_rss[0],"rows":rows,"queries":queries}
    Path(args.output).write_text(json.dumps(output,ensure_ascii=False))
    print(json.dumps({"model":spec.model_id,"chunks":len(rows),"queries":len(queries),"peak_process_rss_bytes":maximum_rss[0]}),flush=True)


if __name__ == "__main__":
    main()
