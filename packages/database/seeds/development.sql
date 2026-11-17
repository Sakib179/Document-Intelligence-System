-- Fictional fixtures only. Referenced objects do not exist in MinIO.
-- Executed in one owner transaction; role/context changes are transaction-local.
INSERT INTO public.tenants (id, name, slug, settings) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Development workspace A', 'development-a', '{"development_fixture":true}'),
  ('22222222-2222-4222-8222-222222222222', 'Development workspace B', 'development-b', '{"development_fixture":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (id, tenant_id, email, display_name, role) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'reviewer-a@example.invalid', 'Development reviewer A', 'admin'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'reviewer-b@example.invalid', 'Development reviewer B', 'reviewer')
ON CONFLICT (id) DO NOTHING;

SET LOCAL ROLE document_intelligence_app;
SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', true);
SELECT set_config('app.user_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
SELECT set_config('app.change_reason', 'Load fictional development fixtures', true);

INSERT INTO public.upload_batches (id, tenant_id, uploaded_by, name, status, expected_file_count, metadata)
VALUES ('10000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Fictional PDF and spreadsheet comparison', 'pending', 2, '{"development_fixture":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.documents (
  id, tenant_id, upload_batch_id, uploaded_by, original_filename, mime_type,
  file_size_bytes, sha256, object_storage_key, document_type, page_count, metadata
) VALUES
  ('20000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'fictional-invoice.pdf', 'application/pdf', 100, repeat('a',64), 'development/fixtures/not-uploaded/invoice.pdf', 'invoice', 1, '{"development_fixture":true,"object_exists":false}'),
  ('20000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'fictional-ledger.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 100, repeat('b',64), 'development/fixtures/not-uploaded/ledger.xlsx', 'spreadsheet', 1, '{"development_fixture":true,"object_exists":false}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.processing_jobs (id, tenant_id, document_id, job_type, pipeline_version, idempotency_key, checkpoint)
VALUES ('30000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '20000000-0000-4000-8000-000000000001', 'development_fixture', 'fixture-v1', 'development-fixture-a', '{"development_fixture":true,"not_dispatched":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.extraction_runs (id, tenant_id, document_id, processing_job_id, source_reference)
VALUES ('40000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '{"development_fixture":true,"not_executed":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.document_pages (
  id, tenant_id, document_id, page_number, source_kind, extracted_text,
  extraction_method, coordinate_system, worksheet_name, cell_range, source_reference
) VALUES
  ('41000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '20000000-0000-4000-8000-000000000001', 1, 'pdf_page', 'DEVELOPMENT FIXTURE. DEMO-001 Sample supplier. Reported total 110.', 'digital', 'pdf_points', NULL, NULL, '{"development_fixture":true,"manually_supplied":true}'),
  ('41000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '20000000-0000-4000-8000-000000000002', 1, 'worksheet', 'DEVELOPMENT FIXTURE. DEMO-001 Ledger total 115.', 'spreadsheet', 'worksheet', 'Invoices', 'A1:C2', '{"development_fixture":true,"manually_supplied":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.document_blocks (
  id, tenant_id, document_id, page_id, block_number, block_type, extracted_text,
  extraction_method, bounding_box, coordinate_system, table_data, worksheet_name, cell_range, source_reference
) VALUES
  ('42000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '20000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', 1, 'text', 'DEMO-001. Reported total 110.', 'digital', ARRAY[10,10,200,30]::float8[], 'pdf_points', NULL, NULL, NULL, '{"development_fixture":true}'),
  ('42000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '20000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000002', 1, 'table', 'DEMO-001,Sample supplier,115', 'spreadsheet', NULL, 'worksheet', '{"headers":["invoice_number","supplier","total"],"rows":[["DEMO-001","Sample supplier","115"]]}', 'Invoices', 'A1:C2', '{"development_fixture":true,"cells":{"total":"C2"}}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.invoices (
  id, tenant_id, source_document_id, source_page_id, source_block_id,
  invoice_number, invoice_date, supplier_name, customer_name, subtotal, tax,
  total, currency, extraction_metadata, field_evidence, review_status
) VALUES
  ('50000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '20000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', 'DEMO-001', '2026-11-01', 'Sample supplier', 'Sample customer', '100', '10', '110', 'USD', '{"origin":"development_fixture","not_model_extracted":true}', '{"total":[{"page_number":1,"quote":"Reported total 110.","development_fixture":true}]}', 'needs_review'),
  ('50000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '20000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', 'DEMO-001', '2026-11-01', 'Sample supplier', 'Sample customer', '100', '10', '110', 'USD', '{"origin":"development_fixture","duplicate_candidate":true}', '{}', 'needs_review')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.invoice_line_items (
  id, tenant_id, invoice_id, source_document_id, source_page_id,
  line_number, description, quantity, unit_price, tax_rate, line_total, source_evidence
) VALUES (
  '60000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  '50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001', 1, 'Fictional service', '2', '50', '0.10', '100',
  '{"development_fixture":true,"page_number":1}'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.validation_issues (
  id, tenant_id, document_id, invoice_id, related_document_id, related_invoice_id,
  issue_code, severity, message, expected_value, actual_value, source_evidence
) VALUES (
  '70000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  '20000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
  'DUPLICATE_CANDIDATE', 'warning', 'Fictional duplicate candidate; no detector was executed.',
  '{"duplicate":false}', '{"invoice_number":"DEMO-001"}', '{"development_fixture":true}'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.reconciliation_runs (
  id, tenant_id, left_document_id, right_document_id, requested_by, reconciliation_type, configuration
) VALUES (
  '80000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'pdf_to_spreadsheet', '{"development_fixture":true,"not_executed":true}'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.reconciliation_items (
  id, tenant_id, reconciliation_run_id, left_document_id, right_document_id,
  left_invoice_id, right_block_id, field_path, match_status, issue_code, severity,
  expected_value, actual_value, source_evidence
) VALUES (
  '81000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  '80000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000002', 'total', 'mismatch',
  'AMOUNT_MISMATCH', 'warning', '"110"', '"115"', '{"development_fixture":true,"manually_supplied":true,"worksheet":"Invoices","cell":"C2"}'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.document_chunks (
  id, tenant_id, document_id, invoice_id, source_page_id, chunk_number, chunk_text, source_reference
) VALUES (
  '90000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  '20000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001', 1, 'DEVELOPMENT FIXTURE DEMO-001 Sample supplier invoice total 110.',
  '{"development_fixture":true,"page_number":1}'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.change_reason', 'Demonstrate a fictional manual correction; not a financial approval', true);
UPDATE public.invoices SET total = '111'
WHERE id = '50000000-0000-4000-8000-000000000001' AND revision = 1;

SELECT set_config('app.tenant_id', '22222222-2222-4222-8222-222222222222', true);
SELECT set_config('app.user_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
SELECT set_config('app.change_reason', 'Load isolated second-tenant fixture', true);
INSERT INTO public.documents (
  id, tenant_id, uploaded_by, original_filename, mime_type, file_size_bytes, sha256, object_storage_key, metadata
) VALUES (
  '20000000-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'fictional-isolated.csv', 'text/csv', 100,
  repeat('c',64), 'development/fixtures/not-uploaded/isolated.csv', '{"development_fixture":true,"object_exists":false}'
)
ON CONFLICT (id) DO NOTHING;
