-- Up Migration
-- Workflow intent shares authoritative job state; no tenant-discovery SELECT grant.
CREATE INDEX workflow_pending_idx ON public.processing_jobs(dispatch_available_at,created_at)
  WHERE job_type='workflow' AND status IN ('pending','retry_wait','running');
CREATE FUNCTION public.schedule_document_workflow() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE doc uuid; event_key text; active boolean;
BEGIN
  IF TG_TABLE_NAME='processing_jobs' THEN
    IF NEW.job_type NOT IN ('ingest','extract') OR NEW.status<>'succeeded' OR OLD.status='succeeded' THEN RETURN NEW;END IF;
    doc:=NEW.document_id;event_key:='workflow:complete:'||NEW.id;
  ELSE
    doc:=NEW.source_document_id;event_key:='workflow:correction:'||TG_TABLE_NAME||':'||NEW.id||':'||NEW.revision;
  END IF;
  SELECT metadata#>>'{workflow,enabled}'='true' INTO active FROM public.documents WHERE tenant_id=NEW.tenant_id AND id=doc;
  IF NOT COALESCE(active,false) THEN RETURN NEW;END IF;
  INSERT INTO public.processing_jobs(tenant_id,document_id,job_type,pipeline_version,idempotency_key,max_attempts,payload)
    VALUES(NEW.tenant_id,doc,'workflow','workflow-v1',event_key,5,jsonb_build_object('kind','refresh'))
    ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
  RETURN NEW;
END;$$;
CREATE TRIGGER workflow_after_completion AFTER UPDATE ON public.processing_jobs FOR EACH ROW EXECUTE FUNCTION public.schedule_document_workflow();
CREATE TRIGGER workflow_after_correction AFTER UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.schedule_document_workflow();
CREATE TRIGGER workflow_after_line_correction AFTER UPDATE ON public.invoice_line_items FOR EACH ROW EXECUTE FUNCTION public.schedule_document_workflow();
REVOKE ALL ON FUNCTION public.schedule_document_workflow() FROM PUBLIC;

CREATE FUNCTION public.claim_workflow_job() RETURNS SETOF public.processing_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item public.processing_jobs%ROWTYPE;
BEGIN
  SELECT j.* INTO item FROM public.processing_jobs j JOIN public.tenants t ON t.id=j.tenant_id AND t.status='active'
    WHERE j.job_type='workflow' AND j.status IN ('pending','retry_wait','running') AND j.dispatch_available_at<=clock_timestamp()
    AND (j.execution_lease_until IS NULL OR j.execution_lease_until<=clock_timestamp())
    ORDER BY j.dispatch_available_at,j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED;
  IF NOT FOUND THEN RETURN;END IF;
  PERFORM set_config('app.tenant_id',item.tenant_id::text,true);PERFORM set_config('app.user_id','',true);
  PERFORM set_config('app.change_reason','Claim durable document workflow',true);
  IF item.attempts>=item.max_attempts THEN
    UPDATE public.processing_jobs SET status='failed',finished_at=clock_timestamp(),execution_lease_token=NULL,execution_lease_until=NULL,last_error_code='WORKFLOW_RETRIES_EXHAUSTED' WHERE id=item.id;
    RETURN;
  END IF;
  UPDATE public.processing_jobs SET status='running',attempts=attempts+1,started_at=COALESCE(started_at,clock_timestamp()),
    execution_lease_token=gen_random_uuid(),execution_lease_until=clock_timestamp()+interval '180 seconds'
    WHERE id=item.id RETURNING * INTO item;
  RETURN NEXT item;
END;$$;
REVOKE ALL ON FUNCTION public.claim_workflow_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_workflow_job() TO document_intelligence_dispatcher;

-- Down Migration
DROP TRIGGER workflow_after_completion ON public.processing_jobs;
DROP TRIGGER workflow_after_correction ON public.invoices;
DROP TRIGGER workflow_after_line_correction ON public.invoice_line_items;
DROP FUNCTION public.schedule_document_workflow();
DROP FUNCTION public.claim_workflow_job();
DROP INDEX public.workflow_pending_idx;
-- Retain completed workflow history. Cancel unfinished work with tenant audit context.
DO $$DECLARE item record;BEGIN
 FOR item IN SELECT id,tenant_id FROM public.processing_jobs WHERE job_type='workflow' AND status IN ('pending','running','retry_wait') LOOP
  PERFORM set_config('app.tenant_id',item.tenant_id::text,true);PERFORM set_config('app.user_id','',true);PERFORM set_config('app.change_reason','Rollback workflow scheduling',true);
  UPDATE public.processing_jobs SET status='cancelled',finished_at=clock_timestamp(),execution_lease_token=NULL,execution_lease_until=NULL WHERE id=item.id;
 END LOOP;
END;$$;
