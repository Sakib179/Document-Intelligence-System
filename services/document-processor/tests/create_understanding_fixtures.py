"""Real format fixtures for understanding integration; no inferred ground truth."""
from pathlib import Path
import sys

import openpyxl
import pymupdf
import xlwt


def invoice(number, supplier="Acme", counter="Page 1 of 1", continued=False):
    return f"TAX INVOICE\nInvoice No: {number}\nSupplier: {supplier}\nDescription Qty Amount\nWidget 1 100\nTotal 100\n{counter}" + ("\nContinued" if continued else "")


def create_fixtures(directory):
    cases = {
        "ai-invoice": ["INVOICE\nInvoice Number: INV-101\nInvoice Date: 2026-11-15\nSupplier: Acme Ltd\nCustomer: Example Buyer\nDescription Quantity Unit Price Tax Rate Line Total\nWidget 2 50.00 15% 100.00\nSubtotal: 100.00\nTax: 15.00\nGrand Total: 115.00\nCurrency: USD\nPage 1 of 1"],
        "single-invoice": [invoice("A-100")],
        "multi-invoice": [invoice("A-100", counter="Page 1 of 2"), invoice("A-100", counter="Page 2 of 2", continued=True), invoice("B-200", "Other Supplier")],
        "ambiguous-invoice": [invoice("A-100", counter=""), "Continued\nDescription Qty Amount\nUnlabeled line 1 50"],
        "receipt": ["PAYMENT RECEIPT\nMerchant: Example Store\nReference invoice no A-100\nPaid 100"],
        "business": ["PURCHASE ORDER\nOrder No PO-100\nSupplier: Acme"],
    }
    for name, texts in cases.items():
        with pymupdf.open() as document:
            for text in texts:
                document.new_page().insert_text((50, 70), text, fontsize=12)
            document.save(directory / (name + ".pdf"), deflate=True)
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Ledger"
    sheet.append(["Invoice No", "Supplier", "Date", "Total"])
    sheet.append(["A-100", "Acme", "2026-11-15", 100])
    sheet.append(["B-200", "Other Supplier", "2026-11-15", 200])
    sheet = workbook.create_sheet("Line items")
    for row in [["Invoice No", "C-300"], ["Supplier", "Third Supplier"], ["Description", "Qty", "Unit Price", "Total"], ["Widget", 1, 100, 100], ["Other", 2, 50, 100]]:
        sheet.append(row)
    workbook.save(directory / "invoice-tables.xlsx")
    ai_workbook = openpyxl.Workbook()
    ai_sheet = ai_workbook.active
    ai_sheet.title = "Invoice ledger"
    ai_sheet.append(["Invoice No", "Supplier", "Customer", "Date", "Subtotal", "Tax", "Total", "Currency"])
    ai_sheet.append(["INV-101", "Acme Ltd", "Example Buyer", "2026-11-15", "100.00", "15.00", "115.00", "USD"])
    ai_sheet.append(["INV-102", "Other Supplier", "Other Buyer", "2026-11-15", "200.00", "30.00", "230.00", "USD"])
    ai_workbook.save(directory / "ai-ledger.xlsx")
    (directory / "invoice-records.csv").write_text("Invoice No;Supplier;Total\nA-100;Acme;100\nB-200;Other Supplier;200\n", encoding="utf-8")
    legacy = xlwt.Workbook()
    sheet = legacy.add_sheet("Ledger")
    for row_number, row in enumerate([["Invoice No", "Supplier", "Total"], ["A-100", "Acme", 100], ["B-200", "Other Supplier", 200]]):
        for column, value in enumerate(row):
            sheet.write(row_number, column, value)
    legacy.save(str(directory / "invoice-records.xls"))


if __name__ == "__main__":
    create_fixtures(Path(sys.argv[1]))
