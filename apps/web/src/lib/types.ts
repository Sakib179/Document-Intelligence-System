import type { DocumentDto, FinancialInvoice, FinancialValidationReport } from '@doc/contracts';
export interface User {
  id: string;
  display_name: string;
  email: string;
  role: 'reader' | 'reviewer' | 'admin';
  tenant_id: string;
  tenant_name: string;
  upload_limits: {
    max_files: number;
    max_file_bytes: number;
    max_batch_bytes: number;
  };
}
export type DocumentSummary = DocumentDto & {
  validation_status: string;
  validation_stale: boolean;
  provider: string | null;
  model_id: string | null;
};
export interface DocumentPage {
  documents: DocumentSummary[];
  next_cursor: string | null;
}
export interface DashboardData {
  counts: {
    total: number;
    completed: number;
    processing: number;
    failed: number;
    partial: number;
    review_required_invoices: number;
  };
  activity: {
    id: string;
    document_id: string;
    job_type: string;
    status: string;
    updated_at: string;
    original_filename: string;
    last_error_code: string | null;
  }[];
  checked_at: string;
}
export interface ResultData {
  document_id: string;
  status: string;
  document_type: string;
  page_count: number | null;
  processing: Record<string, unknown> | null;
  understanding: Record<string, unknown> | null;
  invoices: FinancialInvoice[];
  provenance: Record<string, {
    provider: string | null;
    model_id: string | null;
    model_version: string | null;
    prompt_version: string | null;
  }>;
  next_cursor: string | null;
}
export interface ProgressData {
  document_id: string;
  status: string;
  jobs: {
    items: {
      id: string;
      job_type: string;
      status: string;
      attempts: number;
      max_attempts: number;
      last_error_code: string | null;
      progress: Record<string, unknown>;
      checkpoint: Record<string, unknown>;
      created_at: string;
    }[];
    next_cursor: string | null;
  };
  job_counts: {
    status: string;
    count: number;
  }[];
  poll_after_ms: number;
}
export interface SourceSummary {
  page_number: number;
  source_kind: string;
  worksheet_name: string | null;
  extraction_method: string;
  ocr_confidence: string | null;
}
export interface SourceData extends SourceSummary {
  extracted_text: string | null;
  source_reference: Record<string, unknown>;
  blocks: {
    block_number: number;
    block_type: string;
    extracted_text: string | null;
    bounding_box: number[] | null;
    ocr_confidence: string | null;
    table_data: unknown;
    source_reference: Record<string, unknown>;
  }[];
  next_after: number | null;
}
export interface ReviewPage {
  items: {
    id: string;
    kind: string;
    document_id: string;
    summary: Record<string, unknown>;
    created_at: string;
  }[];
  next_cursor: string | null;
}
export interface AuditPage {
  items: {
    id: string;
    entity_table: string;
    event_type: string;
    actor_user_id: string | null;
    actor_name: string | null;
    reason: string | null;
    created_at: string;
    before_json: string | null;
    after_json: string | null;
  }[];
  next_cursor: string | null;
}
export interface ValidationHistory {
  invoice: FinancialInvoice;
  financial_status: string | null;
  stale: boolean;
  runs: {
    id: string;
    status: string;
    is_current: boolean;
    created_at: string;
    result: FinancialValidationReport;
  }[];
}
export interface ExtractionHistory {
  configured: boolean;
  runs: {
    id: string;
    status: string;
    provider: string | null;
    model_id: string | null;
    model_version: string | null;
    prompt_version: string | null;
    error_code: string | null;
    invoice: {
      id: string;
    } | null;
  }[];
  next_cursor: string | null;
}
