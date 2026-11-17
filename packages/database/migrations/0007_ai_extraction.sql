-- Up Migration
ALTER TABLE public.documents
  ADD COLUMN data_classification text NOT NULL DEFAULT 'confidential' CHECK (data_classification IN ('confidential','public','synthetic')),
  ADD COLUMN data_classified_by uuid,
  ADD COLUMN data_classified_at timestamptz,
  ADD CONSTRAINT documents_classification_actor_fk FOREIGN KEY (tenant_id,data_classified_by) REFERENCES public.users(tenant_id,id),
  ADD CONSTRAINT documents_classification_stamp CHECK ((data_classified_by IS NULL)=(data_classified_at IS NULL) AND (data_classification='confidential' OR data_classified_by IS NOT NULL));
GRANT UPDATE(data_classification) ON public.documents TO document_intelligence_app;
CREATE FUNCTION public.enforce_document_cloud_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE changed boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    changed:=NEW.data_classification<>'confidential' OR NEW.cloud_processing_allowed OR NEW.data_classified_by IS NOT NULL OR NEW.data_classified_at IS NOT NULL;
  ELSE
    changed:=(NEW.data_classification,NEW.cloud_processing_allowed,NEW.cloud_approved_by,NEW.cloud_approved_at,NEW.data_classified_by,NEW.data_classified_at)
      IS DISTINCT FROM (OLD.data_classification,OLD.cloud_processing_allowed,OLD.cloud_approved_by,OLD.cloud_approved_at,OLD.data_classified_by,OLD.data_classified_at);
  END IF;
  IF changed THEN
    PERFORM public.require_change_actor();
    IF NOT EXISTS(SELECT 1 FROM public.users WHERE tenant_id=NEW.tenant_id AND id=public.current_actor_user_id() AND role='admin' AND is_active) THEN
      RAISE EXCEPTION 'Only an active tenant administrator may classify or approve cloud data' USING ERRCODE='42501';
    END IF;
    NEW.data_classified_by:=public.current_actor_user_id(); NEW.data_classified_at:=clock_timestamp();
    IF NEW.cloud_processing_allowed THEN NEW.cloud_approved_by:=public.current_actor_user_id(); NEW.cloud_approved_at:=clock_timestamp();
    ELSE NEW.cloud_approved_by:=NULL; NEW.cloud_approved_at:=NULL; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER b_cloud_policy BEFORE INSERT OR UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.enforce_document_cloud_policy();
REVOKE ALL ON FUNCTION public.enforce_document_cloud_policy() FROM PUBLIC;

ALTER TABLE public.invoice_candidates ADD CONSTRAINT candidates_tenant_document_id UNIQUE(tenant_id,document_id,id);
ALTER TABLE public.processing_jobs
  ADD COLUMN extraction_candidate_id uuid,
  ADD COLUMN source_understanding_run_id uuid,
  ADD CONSTRAINT jobs_extraction_candidate_fk FOREIGN KEY(tenant_id,document_id,extraction_candidate_id) REFERENCES public.invoice_candidates(tenant_id,document_id,id),
  ADD CONSTRAINT jobs_understanding_fk FOREIGN KEY(tenant_id,document_id,source_understanding_run_id) REFERENCES public.document_understanding_runs(tenant_id,document_id,id);
ALTER TABLE public.extraction_runs
  ADD COLUMN candidate_id uuid,
  ADD COLUMN understanding_run_id uuid,
  ADD COLUMN fallback_used boolean NOT NULL DEFAULT false,
  ADD COLUMN processing_time_ms integer CHECK (processing_time_ms>=0),
  ADD COLUMN schema_valid boolean,
  ADD CONSTRAINT extraction_candidate_fk FOREIGN KEY(tenant_id,document_id,candidate_id) REFERENCES public.invoice_candidates(tenant_id,document_id,id),
  ADD CONSTRAINT extraction_understanding_fk FOREIGN KEY(tenant_id,document_id,understanding_run_id) REFERENCES public.document_understanding_runs(tenant_id,document_id,id);
ALTER TABLE public.invoices ADD COLUMN source_candidate_id uuid,
  ADD CONSTRAINT invoices_candidate_fk FOREIGN KEY(tenant_id,source_document_id,source_candidate_id) REFERENCES public.invoice_candidates(tenant_id,document_id,id);
CREATE UNIQUE INDEX invoices_extraction_result_idx ON public.invoices(tenant_id,extraction_run_id) WHERE source_candidate_id IS NOT NULL;
CREATE INDEX extraction_candidates_idx ON public.extraction_runs(tenant_id,document_id,candidate_id,created_at DESC);
CREATE INDEX blocks_cell_row_idx ON public.document_blocks(tenant_id,document_id,page_id,(source_reference#>>'{cell,row}')) WHERE block_type='cell';
CREATE INDEX processing_extraction_outbox_idx ON public.processing_jobs(dispatch_available_at,created_at) WHERE job_type='extract' AND status IN ('pending','queued','running','retry_wait');

CREATE TABLE public.llm_provider_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  provider text NOT NULL CHECK(provider IN ('gemini','local_qwen')), model_id text NOT NULL,
  endpoint_fingerprint text NOT NULL CHECK(endpoint_fingerprint~'^[a-f0-9]{64}$'),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
  success_count integer NOT NULL DEFAULT 0 CHECK(success_count>=0), failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
  last_success_at timestamptz, last_failure_at timestamptz, last_error_code text, circuit_open_until timestamptz,
  UNIQUE(tenant_id,provider,model_id,endpoint_fingerprint)
);
CREATE TABLE public.extraction_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id), document_id uuid NOT NULL,
  extraction_run_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider IN ('gemini','local_qwen')), model_id text NOT NULL, model_version text,
  prompt_version text NOT NULL, attempt_number integer NOT NULL CHECK(attempt_number BETWEEN 1 AND 3), fallback_used boolean NOT NULL,
  status text NOT NULL CHECK(status IN ('running','succeeded','failed')), schema_valid boolean, error_code text,
  processing_time_ms integer CHECK(processing_time_ms>=0), input_sha256 text NOT NULL CHECK(input_sha256~'^[a-f0-9]{64}$'),
  policy_snapshot jsonb NOT NULL, usage_metadata jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  FOREIGN KEY(tenant_id,document_id,extraction_run_id) REFERENCES public.extraction_runs(tenant_id,document_id,id),
  UNIQUE(tenant_id,extraction_run_id,provider,attempt_number),
  CHECK((status IN ('succeeded','failed'))=(finished_at IS NOT NULL))
);
CREATE INDEX attempts_run_idx ON public.extraction_attempts(tenant_id,extraction_run_id,started_at);
CREATE FUNCTION public.protect_extraction_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF OLD.status<>'running' OR (NEW.id,NEW.tenant_id,NEW.document_id,NEW.extraction_run_id,NEW.provider,NEW.model_id,NEW.prompt_version,NEW.attempt_number,NEW.input_sha256,NEW.policy_snapshot)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.document_id,OLD.extraction_run_id,OLD.provider,OLD.model_id,OLD.prompt_version,OLD.attempt_number,OLD.input_sha256,OLD.policy_snapshot) THEN
    RAISE EXCEPTION 'Attempt identity and finalized events are immutable' USING ERRCODE='23514';
  END IF; RETURN NEW;
END; $$;
CREATE TRIGGER a_attempt_identity BEFORE UPDATE ON public.extraction_attempts FOR EACH ROW EXECUTE FUNCTION public.protect_extraction_attempt();
REVOKE ALL ON FUNCTION public.protect_extraction_attempt() FROM PUBLIC;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['extraction_attempts','llm_provider_health'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I TO document_intelligence_app USING(tenant_id=public.current_tenant_id()) WITH CHECK(tenant_id=public.current_tenant_id())',name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.%I TO document_intelligence_app',name);
    EXECUTE format('CREATE TRIGGER a_identity BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.protect_record_identity()',name);
    EXECUTE format('CREATE TRIGGER z_audit AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.record_audit_event()',name);
  END LOOP;
END; $$;

CREATE FUNCTION public.validate_extraction_job() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE candidate public.invoice_candidates%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.job_type='extract' AND
    (NEW.tenant_id,NEW.document_id,NEW.job_type,NEW.pipeline_version,NEW.idempotency_key,NEW.queue_name,NEW.queue_job_id,NEW.payload,NEW.extraction_candidate_id,NEW.source_understanding_run_id)
    IS DISTINCT FROM (OLD.tenant_id,OLD.document_id,OLD.job_type,OLD.pipeline_version,OLD.idempotency_key,OLD.queue_name,OLD.queue_job_id,OLD.payload,OLD.extraction_candidate_id,OLD.source_understanding_run_id) THEN
    RAISE EXCEPTION 'Extraction job identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.job_type='extract' THEN
    SELECT * INTO candidate FROM public.invoice_candidates c WHERE c.tenant_id=NEW.tenant_id AND c.document_id=NEW.document_id AND c.id=NEW.extraction_candidate_id;
    IF NOT FOUND OR candidate.document_type<>'invoice' OR candidate.understanding_run_id IS DISTINCT FROM NEW.source_understanding_run_id
      OR NEW.queue_name IS DISTINCT FROM 'extraction-queue' OR NEW.queue_job_id IS DISTINCT FROM NEW.id::text OR NEW.dispatch_state='not_applicable'
      OR NEW.payload->>'stage' IS DISTINCT FROM 'extract' OR NEW.payload->>'schemaVersion' IS DISTINCT FROM '1'
      OR NEW.payload->>'jobId' IS DISTINCT FROM NEW.id::text OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.payload->>'documentId' IS DISTINCT FROM NEW.document_id::text OR NEW.payload->>'candidateId' IS DISTINCT FROM candidate.id::text
      OR NEW.payload->>'understandingRunId' IS DISTINCT FROM candidate.understanding_run_id::text THEN
      RAISE EXCEPTION 'Extraction payload must match its candidate' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER d_extraction_payload BEFORE INSERT OR UPDATE ON public.processing_jobs FOR EACH ROW EXECUTE FUNCTION public.validate_extraction_job();
REVOKE ALL ON FUNCTION public.validate_extraction_job() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.claim_ingestion_dispatches(claim_limit integer, lease_seconds integer)
RETURNS TABLE (job_id uuid, tenant_id uuid, document_id uuid, payload jsonb, dispatch_token uuid, max_attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item public.processing_jobs%ROWTYPE;
BEGIN
  IF claim_limit NOT BETWEEN 1 AND 100 OR lease_seconds NOT BETWEEN 10 AND 600 THEN
    RAISE EXCEPTION 'Invalid dispatch claim limits' USING ERRCODE='22023';
  END IF;
  FOR item IN
    SELECT j.* FROM public.processing_jobs j JOIN public.tenants t ON t.id=j.tenant_id AND t.status='active'
    WHERE j.job_type IN ('ingest','extract') AND j.status IN ('pending','queued','running','retry_wait')
      AND (j.status<>'running' OR j.execution_lease_until IS NULL OR j.execution_lease_until<=clock_timestamp())
      AND ((j.dispatch_state IN ('pending','retry_wait','published') AND j.dispatch_available_at<=clock_timestamp())
        OR (j.dispatch_state='publishing' AND j.dispatch_lease_until<=clock_timestamp()))
    ORDER BY j.dispatch_available_at,j.created_at LIMIT claim_limit FOR UPDATE OF j SKIP LOCKED
  LOOP
    PERFORM set_config('app.tenant_id',item.tenant_id::text,true);
    PERFORM set_config('app.user_id','',true);
    PERFORM set_config('app.change_reason','Dispatch or recover a durable ingestion job',true);
    IF item.attempts>=item.max_attempts THEN
      UPDATE public.processing_jobs j SET status='failed',finished_at=clock_timestamp(),dispatch_state='dead',
        execution_lease_token=NULL,execution_lease_until=NULL,dispatch_lease_token=NULL,dispatch_lease_until=NULL,
        last_error_code='PROCESSING_RETRIES_EXHAUSTED',last_error_message='Ingestion attempt limit reached'
      WHERE j.id=item.id;
      UPDATE public.documents d SET processing_status=CASE WHEN item.job_type='extract' THEN 'needs_review' ELSE 'failed' END WHERE d.tenant_id=item.tenant_id AND d.id=item.document_id AND d.processing_status NOT IN ('rejected','cancelled');
      CONTINUE;
    END IF;
    UPDATE public.processing_jobs j SET dispatch_state='publishing',dispatch_attempts=j.dispatch_attempts+1,
      dispatch_lease_token=gen_random_uuid(),dispatch_lease_until=clock_timestamp()+make_interval(secs=>lease_seconds)
    WHERE j.id=item.id RETURNING j.* INTO item;
    RETURN QUERY SELECT item.id,item.tenant_id,item.document_id,item.payload,item.dispatch_lease_token,item.max_attempts;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.ack_ingestion_dispatch(target_job uuid, claim_token uuid, published boolean, retry_ms integer, recheck_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item public.processing_jobs%ROWTYPE; failures integer;
BEGIN
  IF retry_ms NOT BETWEEN 100 AND 60000 OR recheck_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'Invalid dispatch retry limits' USING ERRCODE='22023';
  END IF;
  SELECT * INTO item FROM public.processing_jobs j WHERE j.id=target_job AND j.dispatch_lease_token=claim_token AND j.job_type IN ('ingest','extract') FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM set_config('app.tenant_id',item.tenant_id::text,true);
  PERFORM set_config('app.user_id','',true);
  PERFORM set_config('app.change_reason','Acknowledge durable queue dispatch',true);
  IF published THEN
    UPDATE public.processing_jobs j SET dispatch_state='published',dispatch_failures=0,
      dispatch_available_at=clock_timestamp()+make_interval(secs=>recheck_seconds),
      dispatch_lease_token=NULL,dispatch_lease_until=NULL,
      status=CASE WHEN j.status='pending' THEN 'queued' ELSE j.status END
    WHERE j.id=item.id;
    UPDATE public.documents d SET processing_status='queued' WHERE d.id=item.document_id AND d.tenant_id=item.tenant_id AND d.processing_status='uploaded' AND item.job_type='ingest';
  ELSE
    failures:=item.dispatch_failures+1;
    UPDATE public.processing_jobs j SET dispatch_failures=failures,
      dispatch_state=CASE WHEN failures>=j.dispatch_max_failures THEN 'dead' ELSE 'retry_wait' END,
      status=CASE WHEN failures>=j.dispatch_max_failures AND j.status NOT IN ('succeeded','failed','cancelled') THEN 'failed' ELSE j.status END,
      finished_at=CASE WHEN failures>=j.dispatch_max_failures AND j.status NOT IN ('succeeded','failed','cancelled') THEN clock_timestamp() ELSE j.finished_at END,
      dispatch_available_at=clock_timestamp()+make_interval(secs=>LEAST(60.0,(retry_ms/1000.0)*power(2,LEAST(failures-1,10)))),
      dispatch_lease_token=NULL,dispatch_lease_until=NULL,
      last_error_code='QUEUE_UNAVAILABLE',last_error_message='Queue dispatch is temporarily unavailable'
    WHERE j.id=item.id;
    IF failures>=item.dispatch_max_failures AND item.status NOT IN ('succeeded','cancelled') THEN
      UPDATE public.documents d SET processing_status=CASE WHEN item.job_type='extract' THEN 'needs_review' ELSE 'failed' END WHERE d.id=item.document_id AND d.tenant_id=item.tenant_id AND d.processing_status NOT IN ('rejected','cancelled');
    END IF;
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_ingestion_dispatches(integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ack_ingestion_dispatch(uuid,uuid,boolean,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ingestion_dispatches(integer,integer) TO document_intelligence_dispatcher;
GRANT EXECUTE ON FUNCTION public.ack_ingestion_dispatch(uuid,uuid,boolean,integer,integer) TO document_intelligence_dispatcher;


-- Down Migration
-- Stop workers and back up extraction history before downgrading. Preserve invoices/results.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT id,tenant_id FROM public.processing_jobs WHERE job_type='extract' AND status IN ('pending','queued','running','retry_wait') LOOP
    PERFORM set_config('app.tenant_id',item.tenant_id::text,true); PERFORM set_config('app.user_id','',true);
    PERFORM set_config('app.change_reason','Cancel extraction dispatch during downgrade',true);
    UPDATE public.processing_jobs SET status='cancelled',finished_at=clock_timestamp(),dispatch_state='dead',
      execution_lease_token=NULL,execution_lease_until=NULL,dispatch_lease_token=NULL,dispatch_lease_until=NULL WHERE id=item.id;
    UPDATE public.extraction_runs SET status='cancelled',finished_at=clock_timestamp(),error_code='EXTRACTION_DOWNGRADED',error_message='Extraction was cancelled during schema downgrade'
      WHERE processing_job_id=item.id AND status IN ('pending','running');
  END LOOP;
END; $$;
CREATE OR REPLACE FUNCTION public.claim_ingestion_dispatches(claim_limit integer, lease_seconds integer)
RETURNS TABLE (job_id uuid, tenant_id uuid, document_id uuid, payload jsonb, dispatch_token uuid, max_attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item public.processing_jobs%ROWTYPE;
BEGIN
  IF claim_limit NOT BETWEEN 1 AND 100 OR lease_seconds NOT BETWEEN 10 AND 600 THEN
    RAISE EXCEPTION 'Invalid dispatch claim limits' USING ERRCODE='22023';
  END IF;
  FOR item IN
    SELECT j.* FROM public.processing_jobs j JOIN public.tenants t ON t.id=j.tenant_id AND t.status='active'
    WHERE j.job_type='ingest' AND j.status IN ('pending','queued','running','retry_wait')
      AND (j.status<>'running' OR j.execution_lease_until IS NULL OR j.execution_lease_until<=clock_timestamp())
      AND ((j.dispatch_state IN ('pending','retry_wait','published') AND j.dispatch_available_at<=clock_timestamp())
        OR (j.dispatch_state='publishing' AND j.dispatch_lease_until<=clock_timestamp()))
    ORDER BY j.dispatch_available_at,j.created_at LIMIT claim_limit FOR UPDATE OF j SKIP LOCKED
  LOOP
    PERFORM set_config('app.tenant_id',item.tenant_id::text,true);
    PERFORM set_config('app.user_id','',true);
    PERFORM set_config('app.change_reason','Dispatch or recover a durable ingestion job',true);
    IF item.attempts>=item.max_attempts THEN
      UPDATE public.processing_jobs j SET status='failed',finished_at=clock_timestamp(),dispatch_state='dead',
        execution_lease_token=NULL,execution_lease_until=NULL,dispatch_lease_token=NULL,dispatch_lease_until=NULL,
        last_error_code='PROCESSING_RETRIES_EXHAUSTED',last_error_message='Ingestion attempt limit reached'
      WHERE j.id=item.id;
      UPDATE public.documents d SET processing_status='failed' WHERE d.tenant_id=item.tenant_id AND d.id=item.document_id AND d.processing_status<>'ingested';
      CONTINUE;
    END IF;
    UPDATE public.processing_jobs j SET dispatch_state='publishing',dispatch_attempts=j.dispatch_attempts+1,
      dispatch_lease_token=gen_random_uuid(),dispatch_lease_until=clock_timestamp()+make_interval(secs=>lease_seconds)
    WHERE j.id=item.id RETURNING j.* INTO item;
    RETURN QUERY SELECT item.id,item.tenant_id,item.document_id,item.payload,item.dispatch_lease_token,item.max_attempts;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.ack_ingestion_dispatch(target_job uuid, claim_token uuid, published boolean, retry_ms integer, recheck_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item public.processing_jobs%ROWTYPE; failures integer;
BEGIN
  IF retry_ms NOT BETWEEN 100 AND 60000 OR recheck_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'Invalid dispatch retry limits' USING ERRCODE='22023';
  END IF;
  SELECT * INTO item FROM public.processing_jobs j WHERE j.id=target_job AND j.dispatch_lease_token=claim_token AND j.job_type='ingest' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM set_config('app.tenant_id',item.tenant_id::text,true);
  PERFORM set_config('app.user_id','',true);
  PERFORM set_config('app.change_reason','Acknowledge durable queue dispatch',true);
  IF published THEN
    UPDATE public.processing_jobs j SET dispatch_state='published',dispatch_failures=0,
      dispatch_available_at=clock_timestamp()+make_interval(secs=>recheck_seconds),
      dispatch_lease_token=NULL,dispatch_lease_until=NULL,
      status=CASE WHEN j.status='pending' THEN 'queued' ELSE j.status END
    WHERE j.id=item.id;
    UPDATE public.documents d SET processing_status='queued' WHERE d.id=item.document_id AND d.tenant_id=item.tenant_id AND d.processing_status='uploaded';
  ELSE
    failures:=item.dispatch_failures+1;
    UPDATE public.processing_jobs j SET dispatch_failures=failures,
      dispatch_state=CASE WHEN failures>=j.dispatch_max_failures THEN 'dead' ELSE 'retry_wait' END,
      status=CASE WHEN failures>=j.dispatch_max_failures AND j.status NOT IN ('succeeded','failed','cancelled') THEN 'failed' ELSE j.status END,
      finished_at=CASE WHEN failures>=j.dispatch_max_failures AND j.status NOT IN ('succeeded','failed','cancelled') THEN clock_timestamp() ELSE j.finished_at END,
      dispatch_available_at=clock_timestamp()+make_interval(secs=>LEAST(60.0,(retry_ms/1000.0)*power(2,LEAST(failures-1,10)))),
      dispatch_lease_token=NULL,dispatch_lease_until=NULL,
      last_error_code='QUEUE_UNAVAILABLE',last_error_message='Queue dispatch is temporarily unavailable'
    WHERE j.id=item.id;
    IF failures>=item.dispatch_max_failures AND item.status NOT IN ('succeeded','cancelled') THEN
      UPDATE public.documents d SET processing_status='failed' WHERE d.id=item.document_id AND d.tenant_id=item.tenant_id AND d.processing_status<>'ingested';
    END IF;
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_ingestion_dispatches(integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ack_ingestion_dispatch(uuid,uuid,boolean,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ingestion_dispatches(integer,integer) TO document_intelligence_dispatcher;
GRANT EXECUTE ON FUNCTION public.ack_ingestion_dispatch(uuid,uuid,boolean,integer,integer) TO document_intelligence_dispatcher;


DROP TRIGGER d_extraction_payload ON public.processing_jobs;
DROP FUNCTION public.validate_extraction_job();
DROP TABLE public.extraction_attempts;
DROP TABLE public.llm_provider_health;
DROP FUNCTION public.protect_extraction_attempt();
DROP INDEX public.processing_extraction_outbox_idx;
DROP INDEX public.invoices_extraction_result_idx;
DROP INDEX public.extraction_candidates_idx;
DROP INDEX public.blocks_cell_row_idx;
ALTER TABLE public.invoices DROP COLUMN source_candidate_id;
ALTER TABLE public.extraction_runs DROP COLUMN candidate_id,DROP COLUMN understanding_run_id,DROP COLUMN fallback_used,DROP COLUMN processing_time_ms,DROP COLUMN schema_valid;
ALTER TABLE public.processing_jobs DROP COLUMN extraction_candidate_id,DROP COLUMN source_understanding_run_id;
ALTER TABLE public.invoice_candidates DROP CONSTRAINT candidates_tenant_document_id;
DROP TRIGGER b_cloud_policy ON public.documents;
DROP FUNCTION public.enforce_document_cloud_policy();
ALTER TABLE public.documents DROP COLUMN data_classification,DROP COLUMN data_classified_by,DROP COLUMN data_classified_at;
