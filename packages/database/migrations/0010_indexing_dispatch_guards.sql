-- Up Migration
ALTER TABLE public.indexing_runs DROP CONSTRAINT indexing_runs_configuration_check;
ALTER TABLE public.indexing_runs ADD CONSTRAINT indexing_configuration_identity CHECK(COALESCE(
  jsonb_typeof(configuration)='object' AND configuration->>'dimensions'='1024' AND configuration->>'space_id'=space_id
  AND configuration->>'model_id' IN ('Qwen/Qwen3-Embedding-0.6B','microsoft/harrier-oss-v1-0.6b')
  AND configuration->>'model_version'~'^[a-f0-9]{40}$',false));
CREATE FUNCTION public.validate_index_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE run public.indexing_runs%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.job_type='index' AND (NEW.tenant_id,NEW.document_id,NEW.job_type,NEW.pipeline_version,NEW.idempotency_key,NEW.queue_name,NEW.queue_job_id,NEW.payload)
    IS DISTINCT FROM (OLD.tenant_id,OLD.document_id,OLD.job_type,OLD.pipeline_version,OLD.idempotency_key,OLD.queue_name,OLD.queue_job_id,OLD.payload) THEN
    RAISE EXCEPTION 'Index job identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.job_type='index' THEN
    SELECT * INTO run FROM public.indexing_runs WHERE tenant_id=NEW.tenant_id AND document_id=NEW.document_id AND processing_job_id=NEW.id;
    IF NOT FOUND OR NOT COALESCE(NEW.queue_name='indexing-queue' AND NEW.queue_job_id=NEW.id::text
      AND NEW.payload->'schemaVersion'='1'::jsonb AND NEW.payload->>'stage'='index'
      AND NEW.payload->>'jobId'=NEW.id::text AND NEW.payload->>'runId'=run.id::text
      AND NEW.payload->>'documentId'=NEW.document_id::text AND NEW.payload->>'tenantId'=NEW.tenant_id::text,false) THEN
      RAISE EXCEPTION 'Index payload must reference its durable source run' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER index_job_identity AFTER INSERT OR UPDATE ON public.processing_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_index_job();
REVOKE ALL ON FUNCTION public.validate_index_job() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.ack_indexing_dispatch(target_job uuid,claim_token uuid,published boolean,retry_ms integer,recheck_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE item public.processing_jobs%ROWTYPE;failures integer;BEGIN
  IF retry_ms NOT BETWEEN 100 AND 60000 OR recheck_seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid retry limits' USING ERRCODE='22023';END IF;
  SELECT * INTO item FROM public.processing_jobs WHERE id=target_job AND job_type='index' AND dispatch_lease_token=claim_token FOR UPDATE;
  IF NOT FOUND THEN RETURN false;END IF;
  PERFORM set_config('app.tenant_id',item.tenant_id::text,true);PERFORM set_config('app.user_id','',true);PERFORM set_config('app.change_reason','Acknowledge local indexing dispatch',true);
  IF item.status IN ('succeeded','failed','cancelled') THEN
    UPDATE public.processing_jobs SET dispatch_state=CASE WHEN status='succeeded' THEN 'published' ELSE 'dead' END,
      dispatch_lease_token=NULL,dispatch_lease_until=NULL WHERE id=item.id;
    RETURN true;
  END IF;
  failures:=CASE WHEN published THEN 0 ELSE item.dispatch_failures+1 END;
  UPDATE public.processing_jobs SET dispatch_state=CASE WHEN published THEN 'published' WHEN failures>=dispatch_max_failures THEN 'dead' ELSE 'retry_wait' END,
    status=CASE WHEN NOT published AND failures>=dispatch_max_failures THEN 'failed' WHEN status='pending' AND published THEN 'queued' ELSE status END,
    finished_at=CASE WHEN NOT published AND failures>=dispatch_max_failures THEN clock_timestamp() ELSE finished_at END,
    dispatch_failures=failures,dispatch_lease_token=NULL,dispatch_lease_until=NULL,
    dispatch_available_at=clock_timestamp()+make_interval(secs=>CASE WHEN published THEN recheck_seconds ELSE LEAST(60.0,(retry_ms/1000.0)*power(2,LEAST(failures,10))) END),
    last_error_code=CASE WHEN published THEN last_error_code ELSE 'QUEUE_UNAVAILABLE' END WHERE id=item.id;
  IF NOT published AND failures>=item.dispatch_max_failures THEN UPDATE public.indexing_runs SET status='failed',finished_at=clock_timestamp(),error_code='QUEUE_UNAVAILABLE' WHERE processing_job_id=item.id AND status IN ('pending','running');END IF;
  RETURN true;END; $$;

-- Down Migration
DROP TRIGGER index_job_identity ON public.processing_jobs;
DROP FUNCTION public.validate_index_job();
ALTER TABLE public.indexing_runs DROP CONSTRAINT indexing_configuration_identity;
ALTER TABLE public.indexing_runs ADD CONSTRAINT indexing_runs_configuration_check CHECK(jsonb_typeof(configuration)='object' AND configuration->>'dimensions'='1024');
CREATE OR REPLACE FUNCTION public.ack_indexing_dispatch(target_job uuid,claim_token uuid,published boolean,retry_ms integer,recheck_seconds integer)
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
