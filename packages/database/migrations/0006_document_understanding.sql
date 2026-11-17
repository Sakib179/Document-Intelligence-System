-- Up Migration
CREATE TABLE public.document_understanding_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  document_id uuid NOT NULL,
  processing_job_id uuid NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  manifest_key text NOT NULL,
  algorithm_version text NOT NULL CHECK (algorithm_version='segmentation-v1'),
  document_type text NOT NULL CHECK (document_type IN ('invoice','receipt','other_business','unknown')),
  segmentation_confidence numeric(5,4) NOT NULL CHECK (segmentation_confidence BETWEEN 0 AND 1),
  requires_manual_review boolean NOT NULL CHECK (document_type<>'unknown' OR requires_manual_review),
  candidate_count integer NOT NULL CHECK (candidate_count BETWEEN 1 AND 10000),
  invoice_candidate_count integer NOT NULL CHECK (invoice_candidate_count BETWEEN 0 AND candidate_count),
  ai_status text NOT NULL CHECK (ai_status IN ('disabled','not_permitted','not_needed','advised','unavailable','budget_exhausted')),
  warnings jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,document_id,id),
  FOREIGN KEY (tenant_id,document_id) REFERENCES public.documents(tenant_id,id),
  FOREIGN KEY (tenant_id,document_id,processing_job_id) REFERENCES public.processing_jobs(tenant_id,document_id,id)
);
CREATE TABLE public.invoice_candidates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  document_id uuid NOT NULL,
  understanding_run_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  document_type text NOT NULL CHECK (document_type IN ('invoice','receipt','other_business','unknown')),
  segmentation_confidence numeric(5,4) NOT NULL CHECK (segmentation_confidence BETWEEN 0 AND 1),
  requires_manual_review boolean NOT NULL CHECK (document_type<>'unknown' OR requires_manual_review),
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object' AND pg_column_size(data)<=4194304),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,understanding_run_id,ordinal),
  FOREIGN KEY (tenant_id,document_id,understanding_run_id) REFERENCES public.document_understanding_runs(tenant_id,document_id,id),
  CONSTRAINT candidate_data_identity CHECK (COALESCE(
    data->>'candidate_id'=id::text AND data->>'document_id'=document_id::text
    AND data->>'document_type'=document_type
    AND (data->>'requires_manual_review')::boolean=requires_manual_review
    AND (data->>'segmentation_confidence')::numeric=segmentation_confidence
    AND jsonb_typeof(data->'source_pages')='array' AND jsonb_array_length(data->'source_pages')>0
    AND jsonb_typeof(data->'source_locations')='array' AND jsonb_array_length(data->'source_locations')>0, false))
);
CREATE INDEX understanding_document_idx ON public.document_understanding_runs(tenant_id,document_id,created_at DESC,id);
CREATE INDEX understanding_job_idx ON public.document_understanding_runs(tenant_id,processing_job_id);
CREATE INDEX candidate_review_idx ON public.invoice_candidates(tenant_id,requires_manual_review,created_at);
CREATE INDEX candidate_document_idx ON public.invoice_candidates(tenant_id,document_id,understanding_run_id,ordinal);
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['document_understanding_runs','invoice_candidates'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I TO document_intelligence_app USING (tenant_id=public.current_tenant_id()) WITH CHECK (tenant_id=public.current_tenant_id())',name);
    EXECUTE format('GRANT SELECT,INSERT ON public.%I TO document_intelligence_app',name);
    EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_mutation()',name);
    EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_immutable_mutation()',name);
    EXECUTE format('CREATE TRIGGER z_audit AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.record_audit_event()',name);
  END LOOP;
END;
$$;

-- Down Migration
-- Stop API/worker writers and back up candidate results first. Source evidence remains.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT d.id,d.tenant_id FROM public.documents d
    JOIN public.document_understanding_runs r ON r.tenant_id=d.tenant_id AND r.document_id=d.id AND r.id::text=d.metadata#>>'{understanding,runId}'
  LOOP
    PERFORM set_config('app.tenant_id',item.tenant_id::text,true);
    PERFORM set_config('app.user_id','',true);
    PERFORM set_config('app.change_reason','Remove understanding pointers during schema downgrade',true);
    UPDATE public.documents SET metadata=metadata-'understanding',
      document_type=CASE WHEN metadata#>>'{ingestion,inspection,kind}' IN ('spreadsheet','csv') THEN 'spreadsheet' ELSE 'unknown' END
      WHERE id=item.id;
  END LOOP;
END;
$$;
DROP TABLE public.invoice_candidates;
DROP TABLE public.document_understanding_runs;
