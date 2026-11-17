from types import SimpleNamespace
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from document_processor.embedding_models import model_spec,QWEN_ID,QWEN_REVISION,HARRIER_ID,HARRIER_REVISION,query_text,DEFAULT_INSTRUCTION
from document_processor.embeddings import EmbeddingEngine,EmbeddingError,EmbedRequest,generate_embeddings
from document_processor.chunking import ChunkRequest,structure_chunks
from document_processor.main import app


class CharacterTokenizer:
    def encode(self,text,add_special_tokens=False):return list(text)


def request(units,**overrides):
    return ChunkRequest(tenant_id=uuid4(),document_id=uuid4(),units=units,target_tokens=100,maximum_tokens=120,**overrides)


def test_official_query_formats_are_distinct_and_documents_use_no_prompt():
    qwen=model_spec(QWEN_ID,QWEN_REVISION);harrier=model_spec(HARRIER_ID,HARRIER_REVISION)
    assert query_text(qwen,"Retrieve invoices","bill")=="Instruct: Retrieve invoices\nQuery:bill"
    assert query_text(harrier,"Retrieve invoices","bill")=="Instruct: Retrieve invoices\nQuery: bill"


def test_harrier_dimensions_are_not_arbitrarily_truncated():
    with pytest.raises(EmbeddingError,match="DIMENSIONS"):EmbeddingEngine(model_spec(HARRIER_ID,HARRIER_REVISION),512)
    assert EmbeddingEngine(model_spec(QWEN_ID,QWEN_REVISION),512).dimensions==512


def test_loading_is_pinned_offline_and_never_executes_remote_model_code(monkeypatch):
    from transformers import AutoModel, AutoTokenizer
    calls=[]
    class Model:
        def to(self,device):
            assert device=="cpu"
            return self
        def eval(self):return self
    def tokenizer(name,**kwargs):
        calls.append((name,kwargs))
        return object()
    def model(name,**kwargs):
        calls.append((name,kwargs))
        return Model()
    monkeypatch.setattr(AutoTokenizer,"from_pretrained",tokenizer)
    monkeypatch.setattr(AutoModel,"from_pretrained",model)
    engine=EmbeddingEngine(model_spec(QWEN_ID,QWEN_REVISION));engine.load()
    assert len(calls)==2
    for name,options in calls:
        assert name==QWEN_ID and options["revision"]==QWEN_REVISION
        assert options["local_files_only"] is True and options["trust_remote_code"] is False


def test_revision_must_be_immutable_and_remote_code_is_not_a_provider():
    with pytest.raises(ValueError):model_spec(QWEN_ID,"main")
    with pytest.raises(ValueError):model_spec("external/model",QWEN_REVISION)


def fake_engine():
    import torch
    engine=EmbeddingEngine(model_spec(QWEN_ID,QWEN_REVISION))
    class Tokenizer:
        def __call__(self,texts,**kwargs):
            if not kwargs.get("return_tensors"):return {"input_ids":[list(range(len(text))) for text in texts]}
            return {"input_ids":torch.tensor([[0,1,2] for _ in texts]),"attention_mask":torch.tensor([[0,1,1] for _ in texts])}
    class Model:
        calls=0
        def __call__(self,**kwargs):
            self.calls+=1
            hidden=torch.zeros((kwargs["input_ids"].shape[0],3,1024));hidden[:,0,0]=5;hidden[:,-1,1]=2
            return SimpleNamespace(last_hidden_state=hidden)
    engine.tokenizer=Tokenizer();engine.model=Model();return engine


def test_last_token_pooling_normalization_and_tenant_scoped_cache():
    engine=fake_engine()
    first=engine.encode(["invoice","invoice"],"document","instruction","tenant-a")
    assert first["vectors"][0][0]==0 and first["vectors"][0][1]==1
    assert engine.model.calls==1
    assert engine.encode(["invoice"],"document","different unused document instruction","tenant-a")["cache_hits"]==1
    engine.encode(["invoice"],"document","instruction","tenant-b");assert engine.model.calls==2


def test_query_instruction_is_part_of_the_cache_key():
    engine=fake_engine();engine.encode(["bill"],"query","first","a");engine.encode(["bill"],"query","second","a")
    assert engine.model.calls==2


def test_long_inputs_fail_without_silent_truncation():
    engine=fake_engine();engine.maximum_tokens=2
    with pytest.raises(EmbeddingError,match="TOO_LONG"):engine.encode(["too long"],"document","instruction","a")
    assert engine.model.calls==0


def test_chunks_keep_related_table_rows_and_coordinates():
    owner=uuid4();units=[{"unit_id":f"row{i}","page_number":1,"invoice_id":owner,"worksheet":"Ledger","cell_range":f"A{i}:D{i}","kind":"table_row","text":"Widget quantity two unit price fifty"} for i in range(1,4)]
    result=structure_chunks(request(units),CharacterTokenizer())
    assert len(result["chunks"])==1
    chunk=result["chunks"][0];assert chunk["invoice_id"]==str(owner) and len(chunk["source_references"])==3
    assert chunk["source_references"][1]["cell_range"]=="A2:D2"


def test_chunk_boundaries_do_not_merge_invoices_or_pages():
    result=structure_chunks(request([{"unit_id":"a","page_number":1,"invoice_id":uuid4(),"text":"first invoice"},{"unit_id":"b","page_number":1,"invoice_id":uuid4(),"text":"second invoice"},{"unit_id":"c","page_number":2,"text":"unknown page"}]),CharacterTokenizer())
    assert len(result["chunks"])==3


def test_long_bengali_text_is_split_without_loss_or_replacement_characters():
    original="বাংলাদেশের চালান ও পণ্যের বিবরণ "*30
    result=structure_chunks(request([{"unit_id":"bn","page_number":1,"text":original}]),CharacterTokenizer())
    assert len(result["chunks"])>1
    assert all(chunk["token_count"]<=120 and "�" not in chunk["chunk_text"] for chunk in result["chunks"])
    assert "".join(chunk["chunk_text"].replace(" ","") for chunk in result["chunks"])==original.replace(" ","")


def test_repeated_headers_and_page_number_boilerplate_are_not_embedded_repeatedly():
    result=structure_chunks(request([{"unit_id":"h1","page_number":1,"kind":"header","text":"DESCRIPTION QUANTITY"},{"unit_id":"r","page_number":1,"text":"Actual invoice row"},{"unit_id":"h2","page_number":1,"kind":"header","text":"DESCRIPTION QUANTITY"},{"unit_id":"f","page_number":1,"text":"Page 1 of 5"}]),CharacterTokenizer())
    text=" ".join(chunk["chunk_text"] for chunk in result["chunks"])
    assert text.count("DESCRIPTION QUANTITY")==1 and "Page 1" not in text


def test_internal_embeddings_require_auth_and_strict_input(monkeypatch):
    monkeypatch.setenv("PROCESSOR_INTERNAL_TOKEN","embedding-test-internal-token")
    with TestClient(app) as client:
        assert client.post("/internal/embeddings",json={}).status_code==401
        assert client.post("/internal/embeddings",headers={"authorization":"Bearer embedding-test-internal-token"},json={}).status_code==422


def test_model_mismatch_and_disabled_configuration_do_not_load_weights(monkeypatch):
    from document_processor import embeddings
    monkeypatch.setattr(embeddings,"_engine",None);monkeypatch.setenv("EMBEDDINGS_ENABLED","true")
    request=EmbedRequest(tenant_id=uuid4(),model_id=HARRIER_ID,model_version=HARRIER_REVISION,texts=["private invoice"],kind="query")
    with pytest.raises(EmbeddingError,match="MISMATCH"):generate_embeddings(request)
    assert embeddings._engine.model is None
    monkeypatch.setenv("EMBEDDINGS_ENABLED","false")
    with pytest.raises(EmbeddingError,match="DISABLED"):generate_embeddings(request)
