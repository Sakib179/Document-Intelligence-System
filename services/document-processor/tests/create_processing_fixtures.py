"""Small synthetic documents for repeatable OCR/integration measurements."""
import io
from pathlib import Path
import sys

import openpyxl
from PIL import Image, ImageDraw, ImageFont
import pymupdf

REFERENCE_TEXT = "INVOICE 2026\nSupplier Example Company\nTotal 1250 USD"


def text_image():
    image = Image.new("RGB", (1600, 500), "white")
    candidates = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    font_path = next((path for path in candidates if Path(path).exists()), None)
    font = ImageFont.truetype(font_path, 52) if font_path else ImageFont.load_default(size=52)
    draw = ImageDraw.Draw(image)
    for index, line in enumerate(REFERENCE_TEXT.splitlines()):
        draw.text((70, 70 + index * 100), line, fill="black", font=font)
    return image


def create_fixtures(directory: Path):
    directory.mkdir(exist_ok=True, parents=True)
    image = text_image()
    image.save(directory / "process.png")
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((60, 80), "Digital invoice 2026 Supplier Example Total 1250 USD", fontsize=14)
        page = document.new_page(width=800, height=250)
        content = io.BytesIO()
        image.save(content, format="PNG")
        page.insert_image(page.rect, stream=content.getvalue())
        document.save(directory / "process.pdf", deflate=True)
    workbook = openpyxl.Workbook()
    workbook.active.title = "Invoices"
    workbook.active.append(["Supplier", "Amount"])
    workbook.active.append(["Example", 1250])
    workbook.active["C2"] = "=B2+10"
    workbook.create_sheet("Second")["B3"] = "Second worksheet"
    workbook.save(directory / "process.xlsx")
    (directory / "process.csv").write_text("supplier;amount;missing\nExample;1250;\n", encoding="utf-8")


if __name__ == "__main__":
    create_fixtures(Path(sys.argv[1]))
