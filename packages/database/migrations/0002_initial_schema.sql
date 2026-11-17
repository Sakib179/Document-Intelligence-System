-- Up Migration
CREATE DOMAIN public.finite_decimal AS NUMERIC(24, 8)
  CHECK (VALUE IS NULL OR VALUE <> 'NaN'::numeric);

CREATE FUNCTION public.valid_bounding_box(coordinates double precision[])
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public AS $$
  SELECT coordinates IS NULL OR (
    array_ndims(coordinates) = 1 AND array_lower(coordinates, 1) = 1
    AND cardinality(coordinates) = 4
    AND coordinates[1] <= coordinates[3] AND coordinates[2] <= coordinates[4]
    AND NOT EXISTS (
      SELECT 1 FROM unnest(coordinates) AS coordinate
      WHERE coordinate IS NULL
         OR NOT (coordinate > '-Infinity'::float8 AND coordinate < 'Infinity'::float8)
    )
  );
$$;

CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  email text NOT NULL CHECK (length(btrim(email)) > 0),
  display_name text NOT NULL,
  auth_subject text,
  role text NOT NULL DEFAULT 'reviewer' CHECK (role IN ('admin', 'reviewer', 'reader')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, auth_subject)
);

CREATE TABLE public.upload_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  uploaded_by uuid,
  name text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'uploaded', 'partial', 'failed', 'cancelled')),
  expected_file_count integer CHECK (expected_file_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES public.users(tenant_id, id)
);

CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  upload_batch_id uuid,
  uploaded_by uuid,
  original_filename text NOT NULL CHECK (length(original_filename) > 0),
  mime_type text NOT NULL CHECK (length(mime_type) > 0),
  file_size_bytes bigint NOT NULL CHECK (file_size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  object_storage_key text NOT NULL CHECK (length(object_storage_key) > 0),
  document_type text NOT NULL DEFAULT 'unknown'
    CHECK (document_type IN ('unknown', 'invoice', 'invoice_bundle', 'receipt', 'spreadsheet', 'other')),
  page_count integer CHECK (page_count > 0),
  processing_status text NOT NULL DEFAULT 'uploaded'
    CHECK (processing_status IN ('uploaded', 'queued', 'processing', 'processed', 'partially_processed', 'needs_review', 'failed', 'rejected', 'cancelled')),
  cloud_processing_allowed boolean NOT NULL DEFAULT false,
  cloud_approved_by uuid,
  cloud_approved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, upload_batch_id) REFERENCES public.upload_batches(tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES public.users(tenant_id, id),
  FOREIGN KEY (tenant_id, cloud_approved_by) REFERENCES public.users(tenant_id, id),
  CHECK (
    (NOT cloud_processing_allowed AND cloud_approved_by IS NULL AND cloud_approved_at IS NULL)
    OR (cloud_processing_allowed AND cloud_approved_by IS NOT NULL AND cloud_approved_at IS NOT NULL)
  )
);

CREATE TABLE public.processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  document_id uuid NOT NULL,
  parent_job_id uuid,
  job_type text NOT NULL CHECK (length(job_type) > 0),
  pipeline_version text NOT NULL CHECK (length(pipeline_version) > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) > 0),
  queue_name text,
  queue_job_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 100),
  priority smallint NOT NULL DEFAULT 0 CHECK (priority >= 0),
  progress jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(progress) = 'object'),
  checkpoint jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(checkpoint) = 'object'),
  last_error_code text,
  last_error_message text,
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, document_id) REFERENCES public.documents(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_job_id) REFERENCES public.processing_jobs(tenant_id, id),
  CHECK (attempts BETWEEN 0 AND max_attempts),
  CHECK (parent_job_id IS NULL OR parent_job_id <> id),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);

CREATE TABLE public.extraction_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  document_id uuid NOT NULL,
  processing_job_id uuid,
  provider text CHECK (provider IN ('gemini', 'local_qwen', 'manual')),
  model_id text,
  model_version text,
  prompt_version text,
  schema_version text NOT NULL DEFAULT '1',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  source_reference jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source_reference) = 'object'),
  cloud_approval_snapshot jsonb CHECK (jsonb_typeof(cloud_approval_snapshot) = 'object'),
  structured_result jsonb CHECK (jsonb_typeof(structured_result) = 'object'),
  response_metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(response_metadata) = 'object'),
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES public.documents(tenant_id, id),
  FOREIGN KEY (tenant_id, document_id, processing_job_id) REFERENCES public.processing_jobs(tenant_id, document_id, id),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CHECK (status <> 'succeeded' OR (provider IS NOT NULL AND structured_result IS NOT NULL))
);

CREATE TABLE public.document_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  document_id uuid NOT NULL,
  extraction_run_id uuid,
  page_number integer NOT NULL CHECK (page_number > 0),
  source_version integer NOT NULL DEFAULT 1 CHECK (source_version > 0),
  source_kind text NOT NULL DEFAULT 'pdf_page' CHECK (source_kind IN ('pdf_page', 'image_frame', 'worksheet', 'csv')),
  extracted_text text,
  extraction_method text CHECK (extraction_method IN ('digital', 'ocr', 'spreadsheet', 'csv', 'mixed')),
  ocr_confidence numeric(5, 4) CHECK (ocr_confidence BETWEEN 0 AND 1),
  width double precision CHECK (width > 0 AND width < 'Infinity'::float8),
  height double precision CHECK (height > 0 AND height < 'Infinity'::float8),
  coordinate_system text CHECK (coordinate_system IN ('pdf_points', 'image_pixels', 'normalized', 'worksheet')),
  worksheet_name text,
  cell_range text,
  source_reference jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source_reference) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_id, id),
  UNIQUE (tenant_id, document_id, page_number, source_version),
  FOREIGN KEY (tenant_id, document_id) REFERENCES public.documents(tenant_id, id),
  FOREIGN KEY (tenant_id, document_id, extraction_run_id) REFERENCES public.extraction_runs(tenant_id, document_id, id),
  CHECK (source_kind <> 'worksheet' OR worksheet_name IS NOT NULL)
);

CREATE TABLE public.document_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  document_id uuid NOT NULL,
  page_id uuid NOT NULL,
  block_number integer NOT NULL CHECK (block_number > 0),
  block_type text NOT NULL CHECK (block_type IN ('text', 'table', 'cell', 'heading', 'header', 'footer', 'image')),
  extracted_text text,
  extraction_method text CHECK (extraction_method IN ('digital', 'ocr', 'spreadsheet', 'csv', 'mixed')),
  ocr_confidence numeric(5, 4) CHECK (ocr_confidence BETWEEN 0 AND 1),
  bounding_box double precision[] CHECK (public.valid_bounding_box(bounding_box)),
  coordinate_system text CHECK (coordinate_system IN ('pdf_points', 'image_pixels', 'normalized', 'worksheet')),
  table_data jsonb CHECK (jsonb_typeof(table_data) IN ('array', 'object')),
  worksheet_name text,
  cell_range text,
  source_reference jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source_reference) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_id, id),
  UNIQUE (tenant_id, page_id, block_number),
  UNIQUE (tenant_id, document_id, page_id, id),
  FOREIGN KEY (tenant_id, document_id, page_id) REFERENCES public.document_pages(tenant_id, document_id, id),
  CHECK (bounding_box IS NULL OR coordinate_system IS NOT NULL)
);

CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  source_document_id uuid NOT NULL,
  extraction_run_id uuid,
  source_page_id uuid,
  source_block_id uuid,
  segment_number integer NOT NULL DEFAULT 1 CHECK (segment_number > 0),
  invoice_number text,
  invoice_date date,
  supplier_name text,
  supplier_details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(supplier_details) = 'object'),
  customer_name text,
  customer_details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(customer_details) = 'object'),
  subtotal public.finite_decimal,
  tax public.finite_decimal,
  total public.finite_decimal,
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  extraction_metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extraction_metadata) = 'object'),
  field_evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(field_evidence) = 'object'),
  original_values jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(original_values) = 'object'),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'needs_review', 'approved', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source_document_id, id),
  FOREIGN KEY (tenant_id, source_document_id) REFERENCES public.documents(tenant_id, id),
  FOREIGN KEY (tenant_id, source_document_id, extraction_run_id) REFERENCES public.extraction_runs(tenant_id, document_id, id),
  FOREIGN KEY (tenant_id, source_document_id, source_page_id) REFERENCES public.document_pages(tenant_id, document_id, id),
  FOREIGN KEY (tenant_id, source_document_id, source_block_id) REFERENCES public.document_blocks(tenant_id, document_id, id),
  FOREIGN KEY (tenant_id, source_document_id, source_page_id, source_block_id) REFERENCES public.document_blocks(tenant_id, document_id, page_id, id),
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES public.users(tenant_id, id),
  CHECK ((review_status IN ('approved', 'rejected')) = (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL))
);

CREATE TABLE public.invoice_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  invoice_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  source_page_id uuid,
  source_block_id uuid,
  line_number integer NOT NULL CHECK (line_number > 0),
  description text,
  quantity public.finite_decimal,
  unit_price public.finite_decimal,
  tax_rate numeric(10, 6) CHECK (tax_rate BETWEEN 0 AND 1),
  line_total public.finite_decimal,
  source_evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source_evidence) = 'object'),
  original_values jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(original_values) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, id),
  UNIQUE (tenant_id, invoice_id, line_number),
  FOREIGN KEY (tenant_id, source_document_id, invoice_id) REFERENCES public.invoices(tenant_id, source_document_id, id),
  FOREIGN KEY (tenant_id, source_document_id, source_page_id) REFERENCES public.document_pages(tenant_id, document_id, id),
  FOREIGN KEY (tenant_id, source_document_id, source_block_id) REFERENCES public.document_blocks(tenant_id, document_id, id),
  FOREIGN KEY (tenant_id, source_document_id, source_page_id, source_block_id) REFERENCES public.document_blocks(tenant_id, document_id, page_id, id)
);

CREATE TABLE public.validation_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  document_id uuid NOT NULL,
  invoice_id uuid,
  line_item_id uuid,
  extraction_run_id uuid,
  related_document_id uuid,
  related_invoice_id uuid,
  issue_code text NOT NULL CHECK (length(issue_code) > 0),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  field_path text,
  message text NOT NULL,
  expected_value jsonb,
  actual_value jsonb,
  source_evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source_evidence) = 'object'),
  resolution_status text NOT NULL DEFAULT 'open' CHECK (resolution_status IN ('open', 'resolved', 'dismissed')),
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES public.documents(tenant_id, id),
  FOREIGN KEY (tenant_id, document_id, invoice_id) REFERENCES public.invoices(tenant_id, source_document_id, id),
  FOREIGN KEY (tenant_id, invoice_id, line_item_id) REFERENCES public.invoice_line_items(tenant_id, invoice_id, id),
  FOREIGN KEY (tenant_id, document_id, extraction_run_id) REFERENCES public.extraction_runs(tenant_id, document_id, id),
  FOREIGN KEY (tenant_id, related_document_id) REFERENCES public.documents(tenant_id, id),
  FOREIGN KEY (tenant_id, related_document_id, related_invoice_id) REFERENCES public.invoices(tenant_id, source_document_id, id),
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES public.users(tenant_id, id),
  CHECK (line_item_id IS NULL OR invoice_id IS NOT NULL),
  CHECK (related_invoice_id IS NULL OR related_document_id IS NOT NULL),
  CHECK (
    (resolution_status = 'open' AND resolved_by IS NULL AND resolved_at IS NULL)
    OR (resolution_status <> 'open' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution_note IS NOT NULL AND length(btrim(resolution_note)) > 0)
  )
);

CREATE TABLE public.reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  left_document_id uuid NOT NULL,
  right_document_id uuid NOT NULL,
  requested_by uuid,
  reconciliation_type text NOT NULL CHECK (reconciliation_type IN ('pdf_to_pdf', 'pdf_to_spreadsheet')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  configuration jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(configuration) = 'object'),
  result_summary jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(result_summary) = 'object'),
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, left_document_id, right_document_id),
  FOREIGN KEY (tenant_id, left_document_id) REFERENCES public.documents(tenant_id, id),
  FOREIGN KEY (tenant_id, right_document_id) REFERENCES public.documents(tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES public.users(tenant_id, id),
  CHECK (left_document_id <> right_document_id),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  CHECK ((status IN ('succeeded', 'partial', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);

CREATE TABLE public.reconciliation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  reconciliation_run_id uuid NOT NULL,
  left_document_id uuid NOT NULL,
  right_document_id uuid NOT NULL,
  left_invoice_id uuid,
  right_invoice_id uuid,
  left_block_id uuid,
  right_block_id uuid,
  field_path text,
  match_status text NOT NULL CHECK (match_status IN ('matched', 'mismatch', 'missing_left', 'missing_right', 'ambiguous')),
  issue_code text,
  severity text CHECK (severity IN ('info', 'warning', 'error')),
  expected_value jsonb,
  actual_value jsonb,
  source_evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source_evidence) = 'object'),
  resolution_status text NOT NULL DEFAULT 'open' CHECK (resolution_status IN ('open', 'resolved', 'dismissed')),
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, reconciliation_run_id, left_document_id, right_document_id)
    REFERENCES public.reconciliation_runs(tenant_id, id, left_document_id, right_document_id),
  FOREIGN KEY (tenant_id, left_document_id, left_invoice_id) REFERENCES public.invoices(tenant_id, source_document_id, id),
  FOREIGN KEY (tenant_id, right_document_id, right_invoice_id) REFERENCES public.invoices(tenant_id, source_document_id, id),
  FOREIGN KEY (tenant_id, left_document_id, left_block_id) REFERENCES public.document_blocks(tenant_id, document_id, id),
  FOREIGN KEY (tenant_id, right_document_id, right_block_id) REFERENCES public.document_blocks(tenant_id, document_id, id),
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES public.users(tenant_id, id),
  CHECK (match_status = 'matched' OR (issue_code IS NOT NULL AND severity IS NOT NULL)),
  CHECK (
    (resolution_status = 'open' AND resolved_by IS NULL AND resolved_at IS NULL)
    OR (resolution_status <> 'open' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution_note IS NOT NULL AND length(btrim(resolution_note)) > 0)
  )
);

CREATE TABLE public.document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  document_id uuid NOT NULL,
  invoice_id uuid,
  source_page_id uuid,
  source_block_id uuid,
  chunk_number integer NOT NULL CHECK (chunk_number > 0),
  source_version integer NOT NULL DEFAULT 1 CHECK (source_version > 0),
  chunk_text text NOT NULL CHECK (length(btrim(chunk_text)) > 0),
  source_reference jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source_reference) = 'object'),
  embedding vector(1024),
  embedding_model_id text,
  embedding_model_version text,
  embedding_configuration jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(embedding_configuration) = 'object'),
  embedded_at timestamptz,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, chunk_text)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_id, chunk_number, source_version),
  FOREIGN KEY (tenant_id, document_id) REFERENCES public.documents(tenant_id, id),
  FOREIGN KEY (tenant_id, document_id, invoice_id) REFERENCES public.invoices(tenant_id, source_document_id, id),
  FOREIGN KEY (tenant_id, document_id, source_page_id) REFERENCES public.document_pages(tenant_id, document_id, id),
  FOREIGN KEY (tenant_id, document_id, source_block_id) REFERENCES public.document_blocks(tenant_id, document_id, id),
  FOREIGN KEY (tenant_id, document_id, source_page_id, source_block_id) REFERENCES public.document_blocks(tenant_id, document_id, page_id, id),
  CHECK (
    (embedding IS NULL AND embedding_model_id IS NULL AND embedding_model_version IS NULL AND embedded_at IS NULL)
    OR (embedding IS NOT NULL AND embedding_model_id IS NOT NULL AND embedding_model_version IS NOT NULL
      AND length(btrim(embedding_model_id)) > 0 AND length(btrim(embedding_model_version)) > 0
      AND embedded_at IS NOT NULL AND vector_norm(embedding) > 0)
  )
);

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  actor_user_id uuid,
  document_id uuid,
  entity_table text NOT NULL,
  entity_id uuid NOT NULL,
  event_type text NOT NULL,
  change_reason text,
  before_data jsonb,
  after_data jsonb,
  transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES public.users(tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES public.documents(tenant_id, id),
  CHECK (before_data IS NULL OR jsonb_typeof(before_data) = 'object'),
  CHECK (after_data IS NULL OR jsonb_typeof(after_data) = 'object')
);

-- Down Migration
-- Destructive on populated databases: back up first and prefer forward fixes.
DROP TABLE public.audit_events;
DROP TABLE public.document_chunks;
DROP TABLE public.reconciliation_items;
DROP TABLE public.reconciliation_runs;
DROP TABLE public.validation_issues;
DROP TABLE public.invoice_line_items;
DROP TABLE public.invoices;
DROP TABLE public.document_blocks;
DROP TABLE public.document_pages;
DROP TABLE public.extraction_runs;
DROP TABLE public.processing_jobs;
DROP TABLE public.documents;
DROP TABLE public.upload_batches;
DROP TABLE public.users;
DROP TABLE public.tenants;
DROP FUNCTION public.valid_bounding_box(double precision[]);
DROP DOMAIN public.finite_decimal;
