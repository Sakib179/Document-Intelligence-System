-- Up Migration
ALTER TABLE public.upload_batches
  ADD COLUMN idempotency_key text,
  ADD COLUMN request_fingerprint text,
  ADD COLUMN ingestion_lease_token uuid,
  ADD COLUMN ingestion_lease_until timestamptz,
  ADD CONSTRAINT upload_batches_request_pair CHECK (
    (idempotency_key IS NULL AND request_fingerprint IS NULL)
    OR (idempotency_key IS NOT NULL AND length(idempotency_key) BETWEEN 8 AND 128 AND request_fingerprint ~ '^[a-f0-9]{64}$')
  ),
  ADD CONSTRAINT upload_batches_lease_pair CHECK ((ingestion_lease_token IS NULL) = (ingestion_lease_until IS NULL));
CREATE UNIQUE INDEX upload_batches_idempotency_idx ON public.upload_batches (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.documents DROP CONSTRAINT documents_processing_status_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_processing_status_check CHECK (
  processing_status IN ('uploading','uploaded','queued','processing','ingested','processed','partially_processed','needs_review','failed','rejected','cancelled')
);

ALTER TABLE public.processing_jobs
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN dispatch_state text NOT NULL DEFAULT 'not_applicable' CHECK (dispatch_state IN ('not_applicable','pending','publishing','published','retry_wait','dead')),
  ADD COLUMN dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  ADD COLUMN dispatch_failures integer NOT NULL DEFAULT 0 CHECK (dispatch_failures >= 0),
  ADD COLUMN dispatch_max_failures integer NOT NULL DEFAULT 10 CHECK (dispatch_max_failures BETWEEN 1 AND 30),
  ADD COLUMN dispatch_available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN dispatch_lease_token uuid,
  ADD COLUMN dispatch_lease_until timestamptz,
  ADD COLUMN execution_lease_token uuid,
  ADD COLUMN execution_lease_until timestamptz,
  ADD CONSTRAINT processing_jobs_payload_size CHECK (jsonb_typeof(payload)='object' AND pg_column_size(payload) <= 4096),
  ADD CONSTRAINT processing_jobs_dispatch_lease CHECK ((dispatch_lease_token IS NULL) = (dispatch_lease_until IS NULL)),
  ADD CONSTRAINT processing_jobs_execution_lease CHECK ((execution_lease_token IS NULL) = (execution_lease_until IS NULL));
CREATE INDEX processing_jobs_outbox_idx ON public.processing_jobs (dispatch_available_at, created_at)
  WHERE job_type='ingest' AND status IN ('pending','queued','running','retry_wait');

CREATE FUNCTION public.validate_ingestion_job() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source public.documents%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.job_type='ingest' THEN
    IF (NEW.tenant_id,NEW.document_id,NEW.job_type,NEW.pipeline_version,NEW.idempotency_key,NEW.queue_name,NEW.queue_job_id,NEW.payload)
      IS DISTINCT FROM (OLD.tenant_id,OLD.document_id,OLD.job_type,OLD.pipeline_version,OLD.idempotency_key,OLD.queue_name,OLD.queue_job_id,OLD.payload) THEN
      RAISE EXCEPTION 'Ingestion identity and payload are immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.job_type='ingest' THEN
    SELECT * INTO source FROM public.documents d WHERE d.tenant_id=NEW.tenant_id AND d.id=NEW.document_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion source is unavailable' USING ERRCODE='23503'; END IF;
    IF NEW.queue_name IS DISTINCT FROM 'document-queue' OR NEW.queue_job_id IS DISTINCT FROM NEW.id::text
      OR NEW.dispatch_state='not_applicable'
      OR NEW.payload->>'schemaVersion' IS DISTINCT FROM '1'
      OR NEW.payload->>'jobId' IS DISTINCT FROM NEW.id::text
      OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.payload->>'documentId' IS DISTINCT FROM NEW.document_id::text
      OR NEW.payload#>>'{storage,key}' IS DISTINCT FROM source.object_storage_key
      OR NEW.payload#>>'{storage,sha256}' IS DISTINCT FROM source.sha256
      OR NEW.payload#>>'{storage,sizeBytes}' IS DISTINCT FROM source.file_size_bytes::text
      OR NEW.payload#>>'{storage,mimeType}' IS DISTINCT FROM source.mime_type
      OR NEW.payload#>>'{storage,bucket}' IS DISTINCT FROM source.metadata#>>'{ingestion,storageBucket}' THEN
      RAISE EXCEPTION 'Ingestion payload must match its authoritative source' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER c_ingestion_payload BEFORE INSERT OR UPDATE ON public.processing_jobs
FOR EACH ROW EXECUTE FUNCTION public.validate_ingestion_job();
REVOKE ALL ON FUNCTION public.validate_ingestion_job() FROM PUBLIC;

-- The dispatcher login has no business-table SELECT/UPDATE privileges. These two
-- narrowly scoped functions expose only dispatchable references and leased acknowledgments.
GRANT USAGE ON SCHEMA public TO document_intelligence_dispatcher;
CREATE FUNCTION public.claim_ingestion_dispatches(claim_limit integer, lease_seconds integer)
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

CREATE FUNCTION public.ack_ingestion_dispatch(target_job uuid, claim_token uuid, published boolean, retry_ms integer, recheck_seconds integer)
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

-- Down Migration
DROP FUNCTION public.ack_ingestion_dispatch(uuid,uuid,boolean,integer,integer);
DROP FUNCTION public.claim_ingestion_dispatches(integer,integer);
REVOKE USAGE ON SCHEMA public FROM document_intelligence_dispatcher;
DROP TRIGGER c_ingestion_payload ON public.processing_jobs;
DROP FUNCTION public.validate_ingestion_job();
DROP INDEX public.processing_jobs_outbox_idx;
DROP INDEX public.upload_batches_idempotency_idx;
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT id,tenant_id FROM public.documents WHERE processing_status IN ('uploading','ingested') LOOP
    PERFORM set_config('app.tenant_id',item.tenant_id::text,true);
    PERFORM set_config('app.user_id','',true);
    PERFORM set_config('app.change_reason','Downgrade ingestion status representation',true);
    UPDATE public.documents SET processing_status=CASE WHEN processing_status='ingested' THEN 'uploaded' ELSE 'failed' END WHERE id=item.id;
  END LOOP;
END;
$$;
ALTER TABLE public.documents DROP CONSTRAINT documents_processing_status_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_processing_status_check CHECK (
  processing_status IN ('uploaded','queued','processing','processed','partially_processed','needs_review','failed','rejected','cancelled')
);
ALTER TABLE public.processing_jobs DROP COLUMN payload,DROP COLUMN dispatch_state,DROP COLUMN dispatch_attempts,
  DROP COLUMN dispatch_failures,DROP COLUMN dispatch_max_failures,DROP COLUMN dispatch_available_at,
  DROP COLUMN dispatch_lease_token,DROP COLUMN dispatch_lease_until,DROP COLUMN execution_lease_token,DROP COLUMN execution_lease_until;
ALTER TABLE public.upload_batches DROP COLUMN idempotency_key,DROP COLUMN request_fingerprint,
  DROP COLUMN ingestion_lease_token,DROP COLUMN ingestion_lease_until;
