"""Versioned, bounded source evidence; monetary-looking values remain source strings."""
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Source(StrictModel):
    bucket: str = Field(min_length=3, max_length=63)
    key: str = Field(max_length=512)
    sha256: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
    size_bytes: int = Field(gt=0)
    extension: Literal[".pdf", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".xlsx", ".xls", ".csv"]


class ProcessRequest(StrictModel):
    schema_version: Literal[1] = 1
    tenant_id: UUID
    document_id: UUID
    run_id: UUID
    source: Source

    @model_validator(mode="after")
    def validate_source_key(self):
        expected = f"tenants/{self.tenant_id}/documents/{self.document_id}/source{self.source.extension}"
        if self.source.key != expected:
            raise ValueError("Source must identify the tenant/document original")
        return self


class Block(StrictModel):
    block_type: Literal["text", "table", "cell"] = "text"
    text: str = ""
    bounding_box: list[float] | None = Field(default=None, min_length=4, max_length=4)
    confidence: float | None = Field(default=None, ge=0, le=1)
    source_reference: dict = Field(default_factory=dict)
    table_data: list | dict | None = None


class Page(StrictModel):
    record_type: Literal["page"] = "page"
    page_number: int = Field(gt=0)
    source_kind: Literal["pdf_page", "image_frame", "worksheet", "csv"]
    extraction_method: Literal["digital_text", "ocr", "spreadsheet", "csv", "none"]
    text: str = ""
    blocks: list[Block] = Field(default_factory=list)
    width: float | None = Field(default=None, gt=0)
    height: float | None = Field(default=None, gt=0)
    coordinate_system: Literal["pdf_points", "image_pixels", "worksheet"]
    ocr_confidence: float | None = Field(default=None, ge=0, le=1)
    worksheet_name: str | None = None
    source_reference: dict = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    error_code: str | None = None


class Cell(StrictModel):
    reference: str
    row: int = Field(gt=0)
    column: int = Field(gt=0)
    value: str | bool | None
    value_type: str
    formula: str | None = None
    cached_value: str | bool | None = None
    source_reference: dict = Field(default_factory=dict)


class WorksheetRows(StrictModel):
    record_type: Literal["worksheet_rows"] = "worksheet_rows"
    page_number: int = Field(gt=0)
    worksheet_name: str
    row_start: int = Field(gt=0)
    row_end: int = Field(gt=0)
    cells: list[Cell]


class Artifact(StrictModel):
    name: Annotated[str, StringConstraints(pattern=r"^part-[0-9]{5}\.jsonl\.gz$")]
    key: str
    sha256: str
    size_bytes: int = Field(gt=0)
    uncompressed_bytes: int = Field(gt=0)
    records: int = Field(gt=0)


class Manifest(StrictModel):
    schema_version: Literal[1] = 1
    processor_version: Literal["document-v1"] = "document-v1"
    tenant_id: UUID
    document_id: UUID
    run_id: UUID
    document_type: Literal["unknown"] = "unknown"
    source: Source
    status: Literal["processed", "partially_processed", "failed"]
    page_count: int = Field(gt=0)
    error_count: int = Field(ge=0)
    worksheets: list[dict] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    artifacts: list[Artifact]


class ProcessingError(Exception):
    def __init__(self, code: str, status: int = 422):
        self.code, self.status = code, status
        super().__init__(code)
