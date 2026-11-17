-- Up Migration
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO document_intelligence_app;

CREATE FUNCTION public.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;

CREATE FUNCTION public.current_actor_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid;
$$;

CREATE FUNCTION public.require_change_actor() RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.current_actor_user_id();
BEGIN
  IF actor IS NULL OR nullif(btrim(current_setting('app.change_reason', true)), '') IS NULL THEN
    RAISE EXCEPTION 'A correction requires an actor and a change reason' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE tenant_id = public.current_tenant_id() AND id = actor AND is_active
  ) THEN
    RAISE EXCEPTION 'Correction actor does not belong to the active tenant' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END;
$$;

CREATE FUNCTION public.extracted_snapshot(table_name text, payload jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN table_name = 'invoices'
    THEN payload - ARRAY['review_status', 'reviewed_by', 'reviewed_at', 'revision', 'created_at', 'updated_at', 'original_values']
    ELSE payload - ARRAY['revision', 'created_at', 'updated_at', 'original_values'] END;
$$;

CREATE FUNCTION public.preserve_original_values() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE value_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.original_values := public.extracted_snapshot(TG_TABLE_NAME, to_jsonb(NEW));
    NEW.revision := 1;
    IF TG_TABLE_NAME = 'invoices' THEN
      IF NEW.review_status IN ('approved', 'rejected') THEN
        NEW.reviewed_by := public.require_change_actor();
        NEW.reviewed_at := clock_timestamp();
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.original_values IS DISTINCT FROM OLD.original_values THEN
    RAISE EXCEPTION 'Original extracted values are immutable' USING ERRCODE = '23514';
  END IF;
  value_changed := public.extracted_snapshot(TG_TABLE_NAME, to_jsonb(NEW))
    IS DISTINCT FROM public.extracted_snapshot(TG_TABLE_NAME, to_jsonb(OLD));
  IF value_changed THEN
    PERFORM public.require_change_actor();
  END IF;
  IF TG_TABLE_NAME = 'invoices' THEN
    IF value_changed THEN
      -- A correction needs a separate, explicit review decision.
      NEW.review_status := 'needs_review';
      NEW.reviewed_by := NULL;
      NEW.reviewed_at := NULL;
    ELSIF NEW.review_status IS DISTINCT FROM OLD.review_status THEN
      IF NEW.review_status IN ('approved', 'rejected') OR OLD.review_status IN ('approved', 'rejected') THEN
        PERFORM public.require_change_actor();
      END IF;
      IF NEW.review_status IN ('approved', 'rejected') THEN
        NEW.reviewed_by := public.current_actor_user_id();
        NEW.reviewed_at := clock_timestamp();
      ELSE
        NEW.reviewed_by := NULL;
        NEW.reviewed_at := NULL;
      END IF;
    ELSE
      NEW.reviewed_by := OLD.reviewed_by;
      NEW.reviewed_at := OLD.reviewed_at;
    END IF;
  END IF;
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.protect_record_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE old_data jsonb := to_jsonb(OLD); new_data jsonb := to_jsonb(NEW);
BEGIN
  IF NEW.id <> OLD.id OR new_data->'tenant_id' IS DISTINCT FROM old_data->'tenant_id' THEN
    RAISE EXCEPTION 'Record identity and tenant cannot change' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'documents' AND (
    new_data->'sha256' IS DISTINCT FROM old_data->'sha256'
    OR new_data->'object_storage_key' IS DISTINCT FROM old_data->'object_storage_key'
    OR new_data->'file_size_bytes' IS DISTINCT FROM old_data->'file_size_bytes'
    OR new_data->'original_filename' IS DISTINCT FROM old_data->'original_filename'
    OR new_data->'mime_type' IS DISTINCT FROM old_data->'mime_type'
  ) THEN
    RAISE EXCEPTION 'Document source metadata is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'extraction_runs' THEN
    IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
      RAISE EXCEPTION 'Finalized extraction runs are immutable; create another run' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.stamp_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.track_issue_resolution() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    changed := NEW.resolution_status <> 'open';
  ELSE
    changed := NEW.resolution_status IS DISTINCT FROM OLD.resolution_status
      OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note
      OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
      OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at;
  END IF;
  IF changed THEN
    PERFORM public.require_change_actor();
    IF NEW.resolution_status = 'open' THEN
      NEW.resolved_by := NULL;
      NEW.resolved_at := NULL;
      NEW.resolution_note := NULL;
    ELSE
      NEW.resolved_by := public.current_actor_user_id();
      NEW.resolved_at := clock_timestamp();
      NEW.resolution_note := nullif(btrim(NEW.resolution_note), '');
      IF NEW.resolution_note IS NULL THEN
        NEW.resolution_note := current_setting('app.change_reason', true);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Source evidence and audit events are append-only' USING ERRCODE = '23514';
END;
$$;

-- Fixed search_path and fully qualified objects protect this privileged trigger.
-- Application callers cannot INSERT audit records or invoke this function directly.
CREATE FUNCTION public.record_audit_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  after_row jsonb := to_jsonb(NEW);
  before_row jsonb;
  event text := lower(TG_OP);
  source_document uuid;
  actor uuid := public.current_actor_user_id();
BEGIN
  IF public.current_tenant_id() IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Audit tenant context is required' USING ERRCODE = '42501';
  END IF;
  IF actor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users WHERE tenant_id = NEW.tenant_id AND id = actor AND is_active
  ) THEN
    RAISE EXCEPTION 'Invalid tenant actor' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    before_row := to_jsonb(OLD);
    IF TG_TABLE_NAME IN ('invoices', 'invoice_line_items') AND
      public.extracted_snapshot(TG_TABLE_NAME, before_row) IS DISTINCT FROM public.extracted_snapshot(TG_TABLE_NAME, after_row) THEN
      event := 'manual_correction';
    ELSIF TG_TABLE_NAME IN ('validation_issues', 'reconciliation_items') AND (
      before_row->'resolution_status' IS DISTINCT FROM after_row->'resolution_status'
      OR before_row->'resolution_note' IS DISTINCT FROM after_row->'resolution_note'
    ) THEN
      event := 'issue_resolution';
    ELSIF TG_TABLE_NAME = 'invoices' AND before_row->'review_status' IS DISTINCT FROM after_row->'review_status' THEN
      event := 'review_decision';
    END IF;
  END IF;
  source_document := COALESCE(
    (after_row->>'source_document_id')::uuid,
    (after_row->>'document_id')::uuid,
    (after_row->>'left_document_id')::uuid,
    CASE WHEN TG_TABLE_NAME = 'documents' THEN NEW.id END
  );
  -- Large immutable payloads remain on their source rows, referenced by this event.
  IF TG_TABLE_NAME IN ('document_pages', 'document_blocks', 'document_chunks', 'extraction_runs') THEN
    before_row := before_row - ARRAY['extracted_text', 'table_data', 'chunk_text', 'embedding', 'search_vector', 'structured_result'];
    after_row := after_row - ARRAY['extracted_text', 'table_data', 'chunk_text', 'embedding', 'search_vector', 'structured_result'];
  END IF;
  INSERT INTO public.audit_events (
    tenant_id, actor_user_id, document_id, entity_table, entity_id,
    event_type, change_reason, before_data, after_data
  ) VALUES (
    NEW.tenant_id, actor, source_document, TG_TABLE_NAME, NEW.id,
    event, nullif(current_setting('app.change_reason', true), ''), before_row, after_row
  );
  RETURN NEW;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants', 'users', 'upload_batches', 'documents', 'document_pages', 'document_blocks',
    'invoices', 'invoice_line_items', 'extraction_runs', 'validation_issues',
    'reconciliation_runs', 'reconciliation_items', 'document_chunks', 'processing_jobs', 'audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    IF table_name = 'tenants' THEN
      EXECUTE 'CREATE POLICY tenant_isolation ON public.tenants TO document_intelligence_app
        USING (id = public.current_tenant_id()) WITH CHECK (id = public.current_tenant_id())';
    ELSE
      EXECUTE format('CREATE POLICY tenant_isolation ON public.%I TO document_intelligence_app
        USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())', table_name);
    END IF;
    EXECUTE format('GRANT SELECT ON public.%I TO document_intelligence_app', table_name);
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'upload_batches', 'documents', 'document_pages', 'document_blocks', 'invoices', 'invoice_line_items',
    'extraction_runs', 'validation_issues', 'reconciliation_runs', 'reconciliation_items', 'document_chunks', 'processing_jobs'
  ] LOOP
    EXECUTE format('GRANT INSERT ON public.%I TO document_intelligence_app', table_name);
    EXECUTE format('CREATE TRIGGER z_audit AFTER INSERT OR UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.record_audit_event()', table_name);
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'tenants', 'users', 'upload_batches', 'documents', 'invoices', 'invoice_line_items',
    'extraction_runs', 'validation_issues', 'reconciliation_runs', 'reconciliation_items', 'document_chunks', 'processing_jobs'
  ] LOOP
    EXECUTE format('CREATE TRIGGER a_identity BEFORE UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.protect_record_identity()', table_name);
    EXECUTE format('CREATE TRIGGER y_updated_at BEFORE UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.stamp_updated_at()', table_name);
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['document_pages', 'document_blocks', 'audit_events'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_mutation()', table_name);
    EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION public.reject_immutable_mutation()', table_name);
  END LOOP;
END;
$$;

GRANT UPDATE ON public.upload_batches, public.processing_jobs, public.extraction_runs,
  public.invoices, public.invoice_line_items, public.validation_issues,
  public.reconciliation_runs, public.reconciliation_items TO document_intelligence_app;
GRANT UPDATE (document_type, page_count, processing_status, cloud_processing_allowed,
  cloud_approved_by, cloud_approved_at, metadata, updated_at) ON public.documents TO document_intelligence_app;
GRANT UPDATE (embedding, embedding_model_id, embedding_model_version, embedding_configuration,
  embedded_at, updated_at) ON public.document_chunks TO document_intelligence_app;

CREATE TRIGGER b_original_values BEFORE INSERT OR UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.preserve_original_values();
CREATE TRIGGER b_original_values BEFORE INSERT OR UPDATE ON public.invoice_line_items
FOR EACH ROW EXECUTE FUNCTION public.preserve_original_values();
CREATE TRIGGER b_resolution BEFORE INSERT OR UPDATE ON public.validation_issues
FOR EACH ROW EXECUTE FUNCTION public.track_issue_resolution();
CREATE TRIGGER b_resolution BEFORE INSERT OR UPDATE ON public.reconciliation_items
FOR EACH ROW EXECUTE FUNCTION public.track_issue_resolution();

REVOKE ALL ON FUNCTION public.record_audit_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.preserve_original_values() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_record_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stamp_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.track_issue_resolution() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_immutable_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_change_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.require_change_actor() TO document_intelligence_app;

-- Down Migration
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants', 'users', 'upload_batches', 'documents', 'document_pages', 'document_blocks',
    'invoices', 'invoice_line_items', 'extraction_runs', 'validation_issues',
    'reconciliation_runs', 'reconciliation_items', 'document_chunks', 'processing_jobs', 'audit_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS a_identity ON public.%I', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS b_original_values ON public.%I', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS b_resolution ON public.%I', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS y_updated_at ON public.%I', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS z_audit ON public.%I', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS immutable_rows ON public.%I', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS immutable_truncate ON public.%I', table_name);
    EXECUTE format('DROP POLICY tenant_isolation ON public.%I', table_name);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON public.%I FROM document_intelligence_app', table_name);
  END LOOP;
END;
$$;
REVOKE UPDATE (document_type, page_count, processing_status, cloud_processing_allowed,
  cloud_approved_by, cloud_approved_at, metadata, updated_at) ON public.documents FROM document_intelligence_app;
REVOKE UPDATE (embedding, embedding_model_id, embedding_model_version, embedding_configuration,
  embedded_at, updated_at) ON public.document_chunks FROM document_intelligence_app;
DROP FUNCTION public.record_audit_event();
DROP FUNCTION public.preserve_original_values();
DROP FUNCTION public.protect_record_identity();
DROP FUNCTION public.stamp_updated_at();
DROP FUNCTION public.track_issue_resolution();
DROP FUNCTION public.reject_immutable_mutation();
DROP FUNCTION public.require_change_actor();
DROP FUNCTION public.extracted_snapshot(text, jsonb);
DROP FUNCTION public.current_actor_user_id();
DROP FUNCTION public.current_tenant_id();
REVOKE USAGE ON SCHEMA public FROM document_intelligence_app;
-- Do not restore CREATE to PUBLIC or drop the cluster-wide runtime login.
