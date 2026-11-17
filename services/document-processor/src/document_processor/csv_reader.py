"""Bounded encoding/delimiter detection followed by streaming CSV iteration."""
import codecs
import csv
from pathlib import Path

from charset_normalizer import from_bytes

from .models import ProcessingError


def csv_format(path: Path) -> tuple[str, str, list[str]]:
    with path.open("rb") as source:
        sample = source.read(65_536)
    warnings = []
    if sample.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encoding = "utf-16"
    elif sample.startswith(codecs.BOM_UTF8):
        encoding = "utf-8-sig"
    else:
        try:
            codecs.getincrementaldecoder("utf-8")().decode(sample, final=False)
            encoding = "utf-8"
        except UnicodeDecodeError:
            match = from_bytes(sample).best()
            if match is None or match.chaos > 0.1:
                raise ProcessingError("CSV_ENCODING_UNCERTAIN")
            encoding = match.encoding
            warnings.append("CSV_ENCODING_INFERRED")
    text = sample.decode(encoding, errors="replace")
    if any(ord(char) < 32 and char not in "\r\n\t" for char in text):
        raise ProcessingError("SIGNATURE_MISMATCH", 415)
    if text.lstrip().lower().startswith(("<!doctype", "<html", "<script", "<?xml", "%pdf-")):
        raise ProcessingError("SIGNATURE_MISMATCH", 415)
    try:
        delimiter = csv.Sniffer().sniff(text, delimiters=",;\t|").delimiter
    except csv.Error:
        # A single-column file has no delimiter; ragged multi-column input is rejected below.
        delimiter = max(",;\t|", key=lambda candidate: text.count(candidate)) if any(c in text for c in ",;\t|") else ","
    return encoding, delimiter, warnings


def csv_rows(path: Path):
    encoding, delimiter, _ = csv_format(path)
    csv.field_size_limit(1_048_576)
    with path.open("r", encoding=encoding, newline="") as source:
        reader = csv.reader(source, delimiter=delimiter, strict=True)
        width = None
        for number, row in enumerate(reader, 1):
            if number > 1_000_000 or len(row) > 10_000:
                raise ProcessingError("CSV_LIMIT_EXCEEDED", 413)
            if not row:
                continue
            if width is None:
                width = len(row)
            if len(row) != width:
                raise ProcessingError("INVALID_CSV")
            if any(ord(char) < 32 and char not in "\r\n\t" for value in row for char in value):
                raise ProcessingError("SIGNATURE_MISMATCH", 415)
            yield number, row
