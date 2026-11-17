-- Up Migration
ALTER TABLE public.invoices ADD COLUMN financial_terms jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(financial_terms)='object' AND pg_column_size(financial_terms)<=131072);

CREATE TABLE public.financial_validation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  document_id uuid NOT NULL,invoice_id uuid NOT NULL,requested_by uuid,
  request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
  engine_version text NOT NULL,input_sha256 text NOT NULL CHECK(input_sha256~'^[a-f0-9]{64}$'),
  financial_status text NOT NULL CHECK(financial_status IN ('VALID','WARNING','REVIEW_REQUIRED')),
  rules jsonb NOT NULL CHECK(jsonb_typeof(rules)='object'),
  input_snapshot jsonb NOT NULL CHECK(jsonb_typeof(input_snapshot)='object' AND pg_column_size(input_snapshot)<=8388608),
  result jsonb NOT NULL CHECK(COALESCE(jsonb_typeof(result)='object' AND result->>'status'=financial_status AND result->>'engine_version'=engine_version,false)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id,invoice_id,id),UNIQUE(tenant_id,invoice_id,request_key),
  FOREIGN KEY(tenant_id,document_id,invoice_id) REFERENCES public.invoices(tenant_id,source_document_id,id),
  FOREIGN KEY(tenant_id,requested_by) REFERENCES public.users(tenant_id,id),
  CHECK(COALESCE(input_snapshot#>>'{invoice,id}'=invoice_id::text AND input_snapshot#>>'{invoice,document_id}'=document_id::text,false))
);
ALTER TABLE public.financial_validation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_validation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.financial_validation_runs TO document_intelligence_app
  USING(tenant_id=public.current_tenant_id()) WITH CHECK(tenant_id=public.current_tenant_id());
GRANT SELECT,INSERT ON public.financial_validation_runs TO document_intelligence_app;
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON public.financial_validation_runs FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_mutation();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON public.financial_validation_runs FOR EACH STATEMENT EXECUTE FUNCTION public.reject_immutable_mutation();
CREATE TRIGGER z_audit AFTER INSERT ON public.financial_validation_runs FOR EACH ROW EXECUTE FUNCTION public.record_audit_event();
CREATE INDEX financial_validation_history_idx ON public.financial_validation_runs(tenant_id,invoice_id,created_at DESC,id);

ALTER TABLE public.validation_issues
  ADD COLUMN financial_validation_run_id uuid,
  ADD COLUMN financial_severity text CHECK(financial_severity IN ('low','medium','high')),
  ADD COLUMN manual_review_required boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT validation_financial_run_fk FOREIGN KEY(tenant_id,document_id,invoice_id,financial_validation_run_id)
    REFERENCES public.financial_validation_runs(tenant_id,document_id,invoice_id,id),
  ADD CONSTRAINT validation_financial_invoice_required CHECK(financial_validation_run_id IS NULL OR (invoice_id IS NOT NULL AND financial_severity IS NOT NULL));
CREATE INDEX validation_financial_run_idx ON public.validation_issues(tenant_id,financial_validation_run_id) WHERE financial_validation_run_id IS NOT NULL;
ALTER TABLE public.reconciliation_runs
  ADD COLUMN engine_version text,
  ADD COLUMN financial_status text CHECK(financial_status IN ('VALID','WARNING','REVIEW_REQUIRED')),
  ADD COLUMN request_key text CHECK(length(request_key) BETWEEN 8 AND 128),
  ADD COLUMN input_sha256 text CHECK(input_sha256~'^[a-f0-9]{64}$'),
  ADD COLUMN input_snapshot jsonb CHECK(input_snapshot IS NULL OR jsonb_typeof(input_snapshot)='object' AND pg_column_size(input_snapshot)<=16777216),
  ADD CONSTRAINT reconciliation_financial_consistent CHECK(engine_version IS NULL OR COALESCE(
    financial_status IS NOT NULL AND request_key IS NOT NULL AND input_sha256 IS NOT NULL AND input_snapshot IS NOT NULL
    AND status='succeeded' AND result_summary->>'status'=financial_status AND result_summary->>'engine_version'=engine_version,false));
CREATE UNIQUE INDEX reconciliation_request_key_idx ON public.reconciliation_runs(tenant_id,request_key) WHERE request_key IS NOT NULL;
ALTER TABLE public.reconciliation_items
  ADD COLUMN financial_severity text CHECK(financial_severity IN ('low','medium','high')),
  ADD COLUMN manual_review_required boolean NOT NULL DEFAULT false;

CREATE FUNCTION public.protect_financial_results() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE protected boolean;
BEGIN
  IF TG_TABLE_NAME='reconciliation_runs' THEN
    IF OLD.engine_version IS NOT NULL AND OLD.status IN ('succeeded','partial','failed','cancelled') THEN
      RAISE EXCEPTION 'Finalized deterministic reconciliation snapshots are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='validation_issues' THEN
    protected:=OLD.financial_validation_run_id IS NOT NULL;
  ELSE
    SELECT r.engine_version IS NOT NULL INTO protected FROM public.reconciliation_runs r WHERE r.tenant_id=OLD.tenant_id AND r.id=OLD.reconciliation_run_id;
  END IF;
  IF protected AND (to_jsonb(NEW)-ARRAY['resolution_status','resolved_by','resolved_at','resolution_note','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['resolution_status','resolved_by','resolved_at','resolution_note','updated_at']) THEN
    RAISE EXCEPTION 'Calculated results are immutable; only their resolution may change' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER c_financial_snapshot BEFORE UPDATE ON public.validation_issues FOR EACH ROW EXECUTE FUNCTION public.protect_financial_results();
CREATE TRIGGER c_financial_snapshot BEFORE UPDATE ON public.reconciliation_runs FOR EACH ROW EXECUTE FUNCTION public.protect_financial_results();
CREATE TRIGGER c_financial_snapshot BEFORE UPDATE ON public.reconciliation_items FOR EACH ROW EXECUTE FUNCTION public.protect_financial_results();
REVOKE ALL ON FUNCTION public.protect_financial_results() FROM PUBLIC;

CREATE FUNCTION public.finance_identity(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT regexp_replace(lower(btrim(normalize(value,NFKC))),'\s+',' ','g');
$$;
CREATE INDEX invoice_duplicate_identity_idx ON public.invoices(tenant_id,public.finance_identity(invoice_number));
CREATE INDEX invoice_duplicate_date_amount_idx ON public.invoices(tenant_id,invoice_date,currency,total);
CREATE INDEX invoice_candidate_latest_idx ON public.invoices(tenant_id,source_document_id,source_candidate_id,created_at DESC,id);

-- Down Migration
-- Export validation snapshots/terms first. Retain existing issue/reconciliation results and audit history.
DROP TRIGGER c_financial_snapshot ON public.validation_issues;
DROP TRIGGER c_financial_snapshot ON public.reconciliation_runs;
DROP TRIGGER c_financial_snapshot ON public.reconciliation_items;
DROP FUNCTION public.protect_financial_results();
DROP INDEX public.validation_financial_run_idx;
ALTER TABLE public.validation_issues DROP CONSTRAINT validation_financial_run_fk,DROP CONSTRAINT validation_financial_invoice_required,
  DROP COLUMN financial_validation_run_id,DROP COLUMN financial_severity,DROP COLUMN manual_review_required;
DROP TABLE public.financial_validation_runs;
DROP INDEX public.reconciliation_request_key_idx;
ALTER TABLE public.reconciliation_runs DROP CONSTRAINT reconciliation_financial_consistent,DROP COLUMN engine_version,DROP COLUMN financial_status,DROP COLUMN request_key,DROP COLUMN input_sha256,DROP COLUMN input_snapshot;
ALTER TABLE public.reconciliation_items DROP COLUMN financial_severity,DROP COLUMN manual_review_required;
DROP INDEX public.invoice_duplicate_identity_idx;
DROP INDEX public.invoice_duplicate_date_amount_idx;
DROP INDEX public.invoice_candidate_latest_idx;
DROP FUNCTION public.finance_identity(text);
ALTER TABLE public.invoices DROP COLUMN financial_terms;
