"""Lazy pages and row batches. Parsers never evaluate formulas, macros or links."""
import base64
from datetime import date, datetime, time
from itertools import zip_longest
import math
import os
from pathlib import Path
import struct

import openpyxl
from openpyxl.utils import get_column_letter
import pymupdf
from PIL import Image, ImageOps
import xlrd
from xlrd.compdoc import CompDoc
from xlrd.formula import FMLA_TYPE_CELL, decompile_formula

from .csv_reader import csv_format, csv_rows
from .models import Block, Cell, Page, ProcessingError, WorksheetRows
from .ocr import ocr_image


def _page_error(number, kind, code, width=None, height=None, worksheet=None):
    return Page(page_number=number, source_kind=kind, extraction_method="none", width=width, height=height,
                coordinate_system="pdf_points" if kind == "pdf_page" else "image_pixels" if kind == "image_frame" else "worksheet",
                worksheet_name=worksheet, error_code=code)


def pdf_pages(path: Path):
    with pymupdf.open(path) as document:
        if document.needs_pass:
            raise ProcessingError("ENCRYPTED_FILE_UNSUPPORTED")
        for index in range(document.page_count):
            try:
                page = document.load_page(index)
                words = page.get_text("words", sort=True)
                text = page.get_text("text", sort=True)
                alphanumeric = sum(char.isalnum() for char in text)
                usable = alphanumeric >= 12 and text.count("\ufffd") / max(1, len(text)) < 0.05
                # Short purely digital labels are still useful; don't OCR them.
                usable = usable or (alphanumeric > 0 and not page.get_images())
                width, height = page.cropbox.width, page.cropbox.height
                if usable:
                    blocks = [Block(text=word[4], bounding_box=list(word[:4]),
                                    source_reference={"pdf_block": word[5], "line": word[6], "word": word[7]}) for word in words]
                    warnings = []
                    try:
                        for table in page.find_tables(strategy="lines").tables:
                            blocks.append(Block(block_type="table", bounding_box=list(table.bbox), table_data=table.extract(),
                                                source_reference={"table_detection": "pdf_vector_lines"}))
                    except Exception:
                        warnings.append("TABLE_EXTRACTION_FAILED")
                    yield Page(page_number=index + 1, source_kind="pdf_page", extraction_method="digital_text",
                               text=text, blocks=blocks, width=width, height=height, coordinate_system="pdf_points",
                               source_reference={"pdf_page": index + 1, "page_rotation": page.rotation}, warnings=warnings)
                else:
                    dpi = int(os.getenv("OCR_RENDER_DPI", "200"))
                    if page.rect.width * page.rect.height * (dpi / 72) ** 2 > 40_000_000:
                        raise ProcessingError("IMAGE_PIXEL_LIMIT_EXCEEDED", 413)
                    pixmap = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB, alpha=False, annots=False)
                    image = Image.frombytes("RGB", [pixmap.width, pixmap.height], pixmap.samples)
                    text, blocks, confidence, metadata, warnings = ocr_image(image)
                    for block in blocks:
                        box = block.bounding_box
                        if box:
                            rectangle = pymupdf.Rect(box[0] * page.rect.width / image.width, box[1] * page.rect.height / image.height,
                                                     box[2] * page.rect.width / image.width, box[3] * page.rect.height / image.height)
                            rectangle = rectangle * page.derotation_matrix
                            block.bounding_box = [max(0, rectangle.x0), max(0, rectangle.y0), min(width, rectangle.x1), min(height, rectangle.y1)]
                    yield Page(page_number=index + 1, source_kind="pdf_page", extraction_method="ocr" if not metadata.get("blank") else "none",
                               text=text, blocks=blocks, width=width, height=height, coordinate_system="pdf_points",
                               ocr_confidence=confidence, source_reference={"pdf_page": index + 1, "render_dpi": dpi, "page_rotation": page.rotation, "preprocessing": metadata}, warnings=warnings)
            except Exception as error:
                yield _page_error(index + 1, "pdf_page", error.code if isinstance(error, ProcessingError) else "PDF_PAGE_FAILED")


def image_pages(path: Path):
    with Image.open(path) as source:
        for index in range(getattr(source, "n_frames", 1)):
            try:
                source.seek(index)
                raw_size, exif_orientation = source.size, source.getexif().get(274, 1)
                image = ImageOps.exif_transpose(source.copy()).convert("RGB")
                if image.width * image.height > 40_000_000:
                    raise ProcessingError("IMAGE_PIXEL_LIMIT_EXCEEDED", 413)
                text, blocks, confidence, metadata, warnings = ocr_image(image)
                yield Page(page_number=index + 1, source_kind="image_frame", extraction_method="ocr" if not metadata.get("blank") else "none",
                           text=text, blocks=blocks, width=image.width, height=image.height, coordinate_system="image_pixels",
                           ocr_confidence=confidence, source_reference={"frame": index + 1, "original_dimensions": list(raw_size),
                               "exif_orientation": exif_orientation, "coordinate_frame": "exif_corrected_source", "preprocessing": metadata}, warnings=warnings)
            except Exception as error:
                yield _page_error(index + 1, "image_frame", error.code if isinstance(error, ProcessingError) else "IMAGE_FRAME_FAILED")


def _scalar(value):
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (date, datetime, time)):
        return value.isoformat()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return str(value)


def _rows(number, name, rows):
    batch, start, end, total = [], None, 0, 0
    for row_number, cells in rows:
        if row_number > 1_000_000:
            raise ProcessingError("WORKSHEET_ROW_LIMIT_EXCEEDED", 413)
        if start is None:
            start = row_number
        end = row_number
        # Bound even a very wide row: each record contains at most 500 cells.
        for cell in cells:
            total += 1
            if total > 2_000_000:
                raise ProcessingError("WORKSHEET_CELL_LIMIT_EXCEEDED", 413)
            batch.append(cell)
            if len(batch) >= 500:
                yield WorksheetRows(page_number=number, worksheet_name=name, row_start=start, row_end=end, cells=batch)
                batch, start = [], row_number
        if batch and row_number - start >= 99:
            yield WorksheetRows(page_number=number, worksheet_name=name, row_start=start, row_end=end, cells=batch)
            batch, start = [], None
    if batch:
        yield WorksheetRows(page_number=number, worksheet_name=name, row_start=start, row_end=end, cells=batch)


def xlsx_pages(path: Path):
    formulas = openpyxl.load_workbook(path, read_only=True, data_only=False, keep_links=False, keep_vba=False)
    cached = openpyxl.load_workbook(path, read_only=True, data_only=True, keep_links=False, keep_vba=False)
    try:
        for number, sheet in enumerate(formulas.worksheets, 1):
            yield Page(page_number=number, source_kind="worksheet", extraction_method="spreadsheet", coordinate_system="worksheet",
                       worksheet_name=sheet.title, source_reference={"worksheet": sheet.title, "worksheet_index": number, "worksheet_state": sheet.sheet_state})
            try:
                cache = cached[sheet.title]
                # Do not trust producer-supplied dimensions, including enormous sparse ranges.
                sheet.reset_dimensions()
                cache.reset_dimensions()

                def rows():
                    for row_number, (row, values) in enumerate(zip_longest(sheet.iter_rows(), cache.iter_rows(), fillvalue=()), 1):
                        if max(len(row), len(values)) > 10_000:
                            raise ProcessingError("WORKSHEET_COLUMN_LIMIT_EXCEEDED", 413)
                        cells = []
                        for column, cell in enumerate(row, 1):
                            value = cell.value
                            is_formula = cell.data_type == "f"
                            formula = value if is_formula and isinstance(value, str) else None
                            if is_formula and formula is None:
                                formula = getattr(value, "text", None)
                            cached_value = values[column - 1].value if column <= len(values) else None
                            cells.append(Cell(reference=f"{get_column_letter(column)}{row_number}", row=row_number, column=column,
                                              value=None if is_formula else _scalar(value), value_type="formula" if is_formula else cell.data_type,
                                              formula=formula, cached_value=_scalar(cached_value) if is_formula else None,
                                              source_reference={"worksheet": sheet.title, "cached_value_available": is_formula and cached_value is not None,
                                                  **({"formula_text_unavailable": True, "formula_attributes": dict(vars(value))} if is_formula and formula is None and hasattr(value, "__dict__") else {})}))
                        yield row_number, cells
                yield from _rows(number, sheet.title, rows())
            except Exception as error:
                # Separate record preserves an already written worksheet header and good row batches.
                yield {"record_type": "source_error", "page_number": number, "error_code": error.code if isinstance(error, ProcessingError) else "WORKSHEET_FAILED"}
    finally:
        formulas.close()
        cached.close()


def _xls_formulas(path, workbook):
    # xlrd exposes cached values only. Read BIFF FORMULA tokens without executing them.
    stream = CompDoc(path.read_bytes()).get_named_stream("Workbook")
    if stream is None:
        stream = CompDoc(path.read_bytes()).get_named_stream("Book")
    formulas, offset, sheet_index = {}, 0, -1
    while stream and offset + 4 <= len(stream):
        opcode, size = struct.unpack_from("<HH", stream, offset)
        data = stream[offset + 4:offset + 4 + size]
        offset += 4 + size
        if len(data) != size:
            raise ProcessingError("CORRUPT_FILE")
        if opcode == 0x0809 and len(data) >= 4 and struct.unpack_from("<H", data, 2)[0] == 0x0010:
            sheet_index += 1
        if opcode == 0x0006 and len(data) >= 22:
            row, column = struct.unpack_from("<HH", data)
            token_length = struct.unpack_from("<H", data, 20)[0]
            tokens = data[22:22 + token_length]
            try:
                text = decompile_formula(workbook, tokens, token_length, FMLA_TYPE_CELL, row, column)
            except Exception:
                text = None
            formulas[(sheet_index, row, column)] = ("=" + text if text and "?" not in text else None, base64.b64encode(tokens).decode("ascii"))
    return formulas


def xls_pages(path: Path):
    workbook = xlrd.open_workbook(str(path), on_demand=True, logfile=open(os.devnull, "w"))
    try:
        formulas = _xls_formulas(path, workbook)
        for index in range(workbook.nsheets):
            name = workbook.sheet_names()[index]
            yield Page(page_number=index + 1, source_kind="worksheet", extraction_method="spreadsheet", coordinate_system="worksheet",
                       worksheet_name=name, source_reference={"worksheet": name, "worksheet_index": index + 1})
            try:
                sheet = workbook.sheet_by_index(index)
                if sheet.ncols > 10_000:
                    raise ProcessingError("WORKSHEET_COLUMN_LIMIT_EXCEEDED", 413)

                def rows():
                    for row_number in range(sheet.nrows):
                        cells = []
                        for column in range(sheet.ncols):
                            cell = sheet.cell(row_number, column)
                            formula = formulas.get((index, row_number, column))
                            value = xlrd.xldate.xldate_as_datetime(cell.value, workbook.datemode) if cell.ctype == xlrd.XL_CELL_DATE else cell.value
                            if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                                value = None
                            if cell.ctype == xlrd.XL_CELL_BOOLEAN:
                                value = bool(value)
                            cells.append(Cell(reference=f"{get_column_letter(column + 1)}{row_number + 1}", row=row_number + 1, column=column + 1,
                                              value=None if formula else _scalar(value), value_type="formula" if formula else str(cell.ctype),
                                              formula=formula[0] if formula else None, cached_value=_scalar(value) if formula else None,
                                              source_reference={"worksheet": name, **({"biff_formula_tokens": formula[1], "formula_text_unavailable": formula[0] is None} if formula else {})}))
                        yield row_number + 1, cells
                yield from _rows(index + 1, name, rows())
                workbook.unload_sheet(index)
            except Exception as error:
                yield {"record_type": "source_error", "page_number": index + 1, "error_code": error.code if isinstance(error, ProcessingError) else "WORKSHEET_FAILED"}
    finally:
        workbook.release_resources()
        workbook.logfile.close()


def csv_pages(path: Path):
    encoding, delimiter, warnings = csv_format(path)
    yield Page(page_number=1, source_kind="csv", extraction_method="csv", coordinate_system="worksheet", worksheet_name="CSV",
               source_reference={"encoding": encoding, "delimiter": delimiter}, warnings=warnings)

    def rows():
        for number, row in csv_rows(path):
            yield number, [Cell(reference=f"{get_column_letter(column)}{number}", row=number, column=column,
                                value=value if value != "" else None, value_type="string" if value else "missing",
                                source_reference={"csv_record": number}) for column, value in enumerate(row, 1)]
    try:
        yield from _rows(1, "CSV", rows())
    except Exception as error:
        yield {"record_type": "source_error", "page_number": 1, "error_code": error.code if isinstance(error, ProcessingError) else "CSV_READ_FAILED"}


def records(path: Path, extension: str):
    if extension == ".pdf":
        yield from pdf_pages(path)
    elif extension == ".xlsx":
        yield from xlsx_pages(path)
    elif extension == ".xls":
        yield from xls_pages(path)
    elif extension == ".csv":
        yield from csv_pages(path)
    else:
        yield from image_pages(path)
