"""Generate real, small format fixtures; never infer or fabricate evaluation results."""
import io
import sys
import zipfile
from pathlib import Path

import pymupdf
import xlwt
from PIL import Image


def create_fixtures(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    with pymupdf.open() as document:
        for _ in range(2):
            document.new_page()
        document.save(directory / "valid.pdf")
    with pymupdf.open() as document:
        document.new_page()
        document.save(directory / "encrypted.pdf", encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="fixture-owner", user_pw="fixture-user")
    for extension, format_name in [("jpg", "JPEG"), ("jpeg", "JPEG"), ("png", "PNG")]:
        Image.new("RGB", (8, 8), (30, 100, 80)).save(directory / ("valid." + extension), format=format_name)
    frames = [Image.new("RGB", (8, 8), color) for color in ["red", "blue"]]
    for extension in ["tif", "tiff"]:
        frames[0].save(directory / ("valid." + extension), format="TIFF", save_all=True, append_images=frames[1:])
    workbook = xlwt.Workbook()
    for name in ["Invoices", "Other sheet"]:
        sheet = workbook.add_sheet(name)
        sheet.write(0, 0, "Fictional fixture")
        sheet.write(0, 1, "No processing")
    workbook.save(str(directory / "valid.xls"))
    with zipfile.ZipFile(directory / "valid.xlsx", "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>')
        archive.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Invoices" sheetId="1" r:id="rId1"/><sheet name="Other sheet" sheetId="2" r:id="rId2"/></sheets></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
        for number in [1, 2]:
            archive.writestr("xl/worksheets/sheet" + str(number) + ".xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>')
    (directory / "valid.csv").write_text('name,total\n"Fictional, supplier",100\n', encoding="utf-8")
    (directory / "utf16.csv").write_text("name,total\nExample,100\n", encoding="utf-16")
    (directory / "single.csv").write_text("name\nExample\n", encoding="utf-8")
    (directory / "invalid.csv").write_text('name,total\n"unclosed,100\n', encoding="utf-8")
    (directory / "fake.pdf").write_text("not a PDF", encoding="utf-8")
    (directory / "fake.xls").write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + bytes(512))
    with zipfile.ZipFile(directory / "fake.xlsx", "w") as archive:
        archive.writestr("word/document.xml", "<document/>")
    with zipfile.ZipFile(directory / "traversal.xlsx", "w") as archive:
        archive.writestr("../escape", "data")
    with zipfile.ZipFile(directory / "bomb.xlsx", "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("huge.xml", "A" * 1_000_000)


if __name__ == "__main__":
    create_fixtures(Path(sys.argv[1]))
