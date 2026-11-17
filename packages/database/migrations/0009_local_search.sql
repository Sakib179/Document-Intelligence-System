-- Up Migration
ALTER TABLE public.documents ADD COLUMN search_generation bigint NOT NULL DEFAULT 0 CHECK(search_generation>=0);
GRANT UPDATE(search_generation) ON public.documents TO document_intelligence_app;
CREATE FUNCTION public.search_source_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_TABLE_NAME='documents' THEN
    IF (NEW.metadata->'processing',NEW.metadata->'understanding') IS DISTINCT FROM (OLD.metadata->'processing',OLD.metadata->'understanding') THEN
      NEW.search_generation:=OLD.search_generation+1;
    ELSIF NEW.search_generation<OLD.search_generation THEN
      RAISE EXCEPTION 'Search generations cannot decrease' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  UPDATE public.documents SET search_generation=search_generation+1 WHERE tenant_id=NEW.tenant_id AND id=NEW.source_document_id;
  RETURN NEW;
END; $$;
CREATE TRIGGER c_search_generation BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.search_source_generation();
CREATE TRIGGER c_search_generation AFTER INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.search_source_generation();
CREATE TRIGGER c_search_generation AFTER INSERT OR UPDATE ON public.invoice_line_items FOR EACH ROW EXECUTE FUNCTION public.search_source_generation();
REVOKE ALL ON FUNCTION public.search_source_generation() FROM PUBLIC;

CREATE TABLE public.indexing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenants(id),document_id uuid NOT NULL,processing_job_id uuid NOT NULL,
  requested_by uuid,request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
  source_generation bigint NOT NULL CHECK(source_generation>=0),source_version integer NOT NULL CHECK(source_version>0),
  space_id text NOT NULL CHECK(space_id~'^[a-f0-9]{64}$'),configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object' AND configuration->>'dimensions'='1024'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
  chunk_count integer NOT NULL DEFAULT 0 CHECK(chunk_count>=0),cache_hits integer NOT NULL DEFAULT 0 CHECK(cache_hits>=0),error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
  UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id,id),UNIQUE(tenant_id,document_id,request_key),UNIQUE(tenant_id,processing_job_id),
  FOREIGN KEY(tenant_id,document_id) REFERENCES public.documents(tenant_id,id),
  FOREIGN KEY(tenant_id,document_id,processing_job_id) REFERENCES public.processing_jobs(tenant_id,document_id,id),
  FOREIGN KEY(tenant_id,requested_by) REFERENCES public.users(tenant_id,id),
  CHECK((status IN ('succeeded','failed','cancelled'))=(finished_at IS NOT NULL))
);
ALTER TABLE public.indexing_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.indexing_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.indexing_runs TO document_intelligence_app USING(tenant_id=public.current_tenant_id()) WITH CHECK(tenant_id=public.current_tenant_id());
GRANT SELECT,INSERT,UPDATE ON public.indexing_runs TO document_intelligence_app;
CREATE TRIGGER a_identity BEFORE UPDATE ON public.indexing_runs FOR EACH ROW EXECUTE FUNCTION public.protect_record_identity();
CREATE TRIGGER z_audit AFTER INSERT OR UPDATE ON public.indexing_runs FOR EACH ROW EXECUTE FUNCTION public.record_audit_event();
CREATE INDEX indexing_document_idx ON public.indexing_runs(tenant_id,document_id,space_id,source_generation,created_at DESC);
CREATE FUNCTION public.protect_indexing_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF OLD.status IN ('succeeded','failed','cancelled') OR (NEW.document_id,NEW.processing_job_id,NEW.configuration,NEW.space_id,NEW.source_generation,NEW.source_version,NEW.request_key)
    IS DISTINCT FROM (OLD.document_id,OLD.processing_job_id,OLD.configuration,OLD.space_id,OLD.source_generation,OLD.source_version,OLD.request_key) THEN
    RAISE EXCEPTION 'Index identity and finalized runs are immutable' USING ERRCODE='23514';
  END IF;RETURN NEW;END; $$;
CREATE TRIGGER b_index_identity BEFORE UPDATE ON public.indexing_runs FOR EACH ROW EXECUTE FUNCTION public.protect_indexing_run();
REVOKE ALL ON FUNCTION public.protect_indexing_run() FROM PUBLIC;

ALTER TABLE public.document_chunks DROP CONSTRAINT document_chunks_tenant_id_document_id_chunk_number_source_v_key;
ALTER TABLE public.document_chunks ADD COLUMN indexing_run_id uuid,
  ADD CONSTRAINT chunks_index_run_fk FOREIGN KEY(tenant_id,document_id,indexing_run_id) REFERENCES public.indexing_runs(tenant_id,document_id,id);
CREATE UNIQUE INDEX chunks_legacy_identity_idx ON public.document_chunks(tenant_id,document_id,chunk_number,source_version) WHERE indexing_run_id IS NULL;
CREATE UNIQUE INDEX chunks_index_identity_idx ON public.document_chunks(tenant_id,indexing_run_id,chunk_number) WHERE indexing_run_id IS NOT NULL;
CREATE INDEX chunks_cache_idx ON public.document_chunks(tenant_id,(embedding_configuration->>'space_id'),(embedding_configuration->>'content_sha256')) WHERE indexing_run_id IS NOT NULL;
CREATE FUNCTION public.validate_indexed_chunk() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE run public.indexing_runs%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.indexing_run_id IS NOT NULL THEN RAISE EXCEPTION 'Indexed chunks are immutable' USING ERRCODE='23514';END IF;
  IF NEW.indexing_run_id IS NOT NULL THEN
    SELECT * INTO run FROM public.indexing_runs WHERE tenant_id=NEW.tenant_id AND document_id=NEW.document_id AND id=NEW.indexing_run_id;
    IF NOT FOUND OR run.status<>'running' OR NEW.embedding IS NULL OR NEW.embedding_model_id IS DISTINCT FROM run.configuration->>'model_id'
      OR NEW.embedding_model_version IS DISTINCT FROM run.configuration->>'model_version'
      OR NEW.embedding_configuration->>'space_id' IS DISTINCT FROM run.space_id OR abs(vector_norm(NEW.embedding)-1)>0.002 THEN
      RAISE EXCEPTION 'Indexed vector identity or normalization mismatch' USING ERRCODE='23514';
    END IF;
  END IF;RETURN NEW;
END; $$;
CREATE TRIGGER b_indexed_chunk BEFORE INSERT OR UPDATE ON public.document_chunks FOR EACH ROW EXECUTE FUNCTION public.validate_indexed_chunk();
REVOKE ALL ON FUNCTION public.validate_indexed_chunk() FROM PUBLIC;

CREATE FUNCTION public.claim_indexing_dispatches(claim_limit integer,lease_seconds integer)
RETURNS TABLE(job_id uuid,tenant_id uuid,document_id uuid,payload jsonb,dispatch_token uuid,max_attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE item public.processing_jobs%ROWTYPE; BEGIN
  IF claim_limit NOT BETWEEN 1 AND 100 OR lease_seconds NOT BETWEEN 10 AND 600 THEN RAISE EXCEPTION 'Invalid dispatch limits' USING ERRCODE='22023';END IF;
  FOR item IN SELECT j.* FROM public.processing_jobs j JOIN public.tenants t ON t.id=j.tenant_id AND t.status='active'
    WHERE j.job_type='index' AND j.status IN ('pending','queued','running','retry_wait')
    AND (j.status<>'running' OR j.execution_lease_until IS NULL OR j.execution_lease_until<=clock_timestamp())
    AND ((j.dispatch_state IN ('pending','retry_wait','published') AND j.dispatch_available_at<=clock_timestamp()) OR (j.dispatch_state='publishing' AND j.dispatch_lease_until<=clock_timestamp()))
    ORDER BY j.dispatch_available_at,j.created_at LIMIT claim_limit FOR UPDATE OF j SKIP LOCKED
  LOOP
    PERFORM set_config('app.tenant_id',item.tenant_id::text,true);PERFORM set_config('app.user_id','',true);PERFORM set_config('app.change_reason','Dispatch durable local indexing',true);
    IF item.attempts>=item.max_attempts THEN
      UPDATE public.processing_jobs SET status='failed',finished_at=clock_timestamp(),dispatch_state='dead',execution_lease_token=NULL,execution_lease_until=NULL,last_error_code='INDEX_RETRIES_EXHAUSTED' WHERE id=item.id;
      UPDATE public.indexing_runs SET status='failed',finished_at=clock_timestamp(),error_code='INDEX_RETRIES_EXHAUSTED' WHERE processing_job_id=item.id AND status IN ('pending','running');CONTINUE;
    END IF;
    UPDATE public.processing_jobs SET dispatch_state='publishing',dispatch_lease_token=gen_random_uuid(),dispatch_lease_until=clock_timestamp()+make_interval(secs=>lease_seconds),dispatch_attempts=dispatch_attempts+1 WHERE id=item.id RETURNING * INTO item;
    RETURN QUERY SELECT item.id,item.tenant_id,item.document_id,item.payload,item.dispatch_lease_token,item.max_attempts;
  END LOOP;END; $$;
CREATE FUNCTION public.ack_indexing_dispatch(target_job uuid,claim_token uuid,published boolean,retry_ms integer,recheck_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE item public.processing_jobs%ROWTYPE;failures integer;BEGIN
  IF retry_ms NOT BETWEEN 100 AND 60000 OR recheck_seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid retry limits' USING ERRCODE='22023';END IF;
  SELECT * INTO item FROM public.processing_jobs WHERE id=target_job AND job_type='index' AND dispatch_lease_token=claim_token FOR UPDATE;
  IF NOT FOUND THEN RETURN false;END IF;
  PERFORM set_config('app.tenant_id',item.tenant_id::text,true);PERFORM set_config('app.user_id','',true);PERFORM set_config('app.change_reason','Acknowledge local indexing dispatch',true);
  failures:=CASE WHEN published THEN 0 ELSE item.dispatch_failures+1 END;
  UPDATE public.processing_jobs SET dispatch_state=CASE WHEN published THEN 'published' WHEN failures>=dispatch_max_failures THEN 'dead' ELSE 'retry_wait' END,
    status=CASE WHEN NOT published AND failures>=dispatch_max_failures THEN 'failed' WHEN status='pending' AND published THEN 'queued' ELSE status END,
    finished_at=CASE WHEN NOT published AND failures>=dispatch_max_failures THEN clock_timestamp() ELSE finished_at END,
    dispatch_failures=failures,dispatch_lease_token=NULL,dispatch_lease_until=NULL,
    dispatch_available_at=clock_timestamp()+make_interval(secs=>CASE WHEN published THEN recheck_seconds ELSE LEAST(60.0,(retry_ms/1000.0)*power(2,LEAST(failures,10))) END),
    last_error_code=CASE WHEN published THEN last_error_code ELSE 'QUEUE_UNAVAILABLE' END WHERE id=item.id;
  IF NOT published AND failures>=item.dispatch_max_failures THEN UPDATE public.indexing_runs SET status='failed',finished_at=clock_timestamp(),error_code='QUEUE_UNAVAILABLE' WHERE processing_job_id=item.id AND status IN ('pending','running');END IF;
  RETURN true;END; $$;
REVOKE ALL ON FUNCTION public.claim_indexing_dispatches(integer,integer),public.ack_indexing_dispatch(uuid,uuid,boolean,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_indexing_dispatches(integer,integer),public.ack_indexing_dispatch(uuid,uuid,boolean,integer,integer) TO document_intelligence_dispatcher;

-- Down Migration
-- Stop writers and export indexing run metadata. Preserve vectors, text and source references.
DROP TRIGGER c_search_generation ON public.documents;
DROP TRIGGER c_search_generation ON public.invoices;
DROP TRIGGER c_search_generation ON public.invoice_line_items;
DROP FUNCTION public.search_source_generation();
DROP TRIGGER b_indexed_chunk ON public.document_chunks;
DROP FUNCTION public.validate_indexed_chunk();
DO $$ DECLARE item record;next_version integer; BEGIN
  FOR item IN SELECT id,tenant_id,document_id FROM public.indexing_runs ORDER BY created_at,id LOOP
    PERFORM set_config('app.tenant_id',item.tenant_id::text,true);PERFORM set_config('app.user_id','',true);PERFORM set_config('app.change_reason','Preserve chunk generations during indexing downgrade',true);
    SELECT COALESCE(MAX(source_version),0)+1 INTO next_version FROM public.document_chunks WHERE document_id=item.document_id AND tenant_id=item.tenant_id;
    UPDATE public.document_chunks SET source_reference=source_reference||jsonb_build_object('rollback_original_source_version',source_version),source_version=next_version WHERE indexing_run_id=item.id;
    UPDATE public.documents SET metadata=metadata-'search' WHERE tenant_id=item.tenant_id AND id=item.document_id;
  END LOOP;
  FOR item IN SELECT id,tenant_id FROM public.processing_jobs WHERE job_type='index' AND status IN ('pending','queued','running','retry_wait') LOOP
    PERFORM set_config('app.tenant_id',item.tenant_id::text,true);PERFORM set_config('app.user_id','',true);PERFORM set_config('app.change_reason','Cancel indexing during downgrade',true);
    UPDATE public.processing_jobs SET status='cancelled',finished_at=clock_timestamp(),dispatch_state='dead',execution_lease_token=NULL,execution_lease_until=NULL WHERE id=item.id;
  END LOOP;
END; $$;
DROP INDEX public.chunks_index_identity_idx;
DROP INDEX public.chunks_legacy_identity_idx;
DROP INDEX public.chunks_cache_idx;
ALTER TABLE public.document_chunks DROP COLUMN indexing_run_id;
ALTER TABLE public.document_chunks ADD CONSTRAINT document_chunks_tenant_id_document_id_chunk_number_source_v_key UNIQUE(tenant_id,document_id,chunk_number,source_version);
DROP TABLE public.indexing_runs;
DROP FUNCTION public.protect_indexing_run();
DROP FUNCTION public.claim_indexing_dispatches(integer,integer);
DROP FUNCTION public.ack_indexing_dispatch(uuid,uuid,boolean,integer,integer);
ALTER TABLE public.documents DROP COLUMN search_generation;
