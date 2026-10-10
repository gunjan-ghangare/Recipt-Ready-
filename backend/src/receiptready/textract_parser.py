"""Turn an Amazon Textract AnalyzeExpense response into ReceiptReady's extraction format.

Response reference: https://docs.aws.amazon.com/textract/latest/dg/API_AnalyzeExpense.html
Standard field types: https://docs.aws.amazon.com/textract/latest/dg/invoices-receipts.html

Textract is the only source of merchant, date, total, currency, and line items. If Textract
doesn't return a value, the field stays empty and is flagged for the user.
"""

from __future__ import annotations

from .normalize import normalize_amount, normalize_date

MAX_LINE_ITEMS = 50


def _confidence(field: dict) -> float | None:
    """Combine type and value confidence. Returns None when Textract didn't report any."""
    scores = [
        part.get("Confidence")
        for part in (field.get("Type") or {}, field.get("ValueDetection") or {})
        if isinstance(part.get("Confidence"), (int, float))
    ]
    return round(min(scores), 1) if scores else None


def _box(field: dict) -> dict | None:
    geometry = (field.get("ValueDetection") or {}).get("Geometry") or {}
    box = geometry.get("BoundingBox")
    if not box:
        return None
    try:
        return {
            "left": round(float(box["Left"]), 4),
            "top": round(float(box["Top"]), 4),
            "width": round(float(box["Width"]), 4),
            "height": round(float(box["Height"]), 4),
            "page": int(field.get("PageNumber") or 1),
        }
    except (KeyError, TypeError, ValueError):
        return None


def _text(field: dict) -> str:
    return ((field.get("ValueDetection") or {}).get("Text") or "").strip()


def _type(field: dict) -> str:
    return ((field.get("Type") or {}).get("Text") or "").upper()


def _best(fields: list[dict], types: tuple[str, ...]) -> dict | None:
    """Pick the field of the earliest-listed type, preferring the highest confidence."""
    for wanted in types:
        candidates = [f for f in fields if _type(f) == wanted and _text(f)]
        if candidates:
            return max(candidates, key=lambda f: _confidence(f) or 0.0)
    return None


# Default for _extracted(): keep the printed text as the value. Distinct from None, which means
# "normalization found nothing usable", so unparseable dates and amounts stay empty (and flagged).
_AS_PRINTED = object()


def _extracted(field: dict | None, value=_AS_PRINTED) -> dict:
    if field is None:
        return {"value": None, "raw": None, "confidence": None, "box": None}
    raw = _text(field)
    return {
        "value": raw if value is _AS_PRINTED else value,
        "raw": raw,
        "confidence": _confidence(field),
        "box": _box(field),
    }


def _currency(fields: list[dict], preferred: dict | None) -> dict:
    def from_field(field: dict | None) -> dict | None:
        if not field:
            return None
        currency = field.get("Currency") or (field.get("ValueDetection") or {}).get("Currency") or {}
        code = str(currency.get("Code") or "").strip().upper()
        if len(code) != 3 or not code.isalpha():
            return None
        conf = currency.get("Confidence")
        return {
            "value": code,
            "raw": code,
            "confidence": round(conf, 1) if isinstance(conf, (int, float)) else None,
            "box": None,
        }

    found = from_field(preferred)
    if found:
        return found
    candidates = [c for c in (from_field(f) for f in fields) if c]
    if candidates:
        return max(candidates, key=lambda c: c["confidence"] or 0.0)
    return {"value": None, "raw": None, "confidence": None, "box": None}


def _line_items(document: dict) -> list[dict]:
    items: list[dict] = []
    for group in document.get("LineItemGroups") or []:
        for line in group.get("LineItems") or []:
            fields = line.get("LineItemExpenseFields") or []
            description = _best(fields, ("ITEM",)) or _best(fields, ("EXPENSE_ROW",))
            price = _best(fields, ("PRICE",))
            quantity = _best(fields, ("QUANTITY",))
            if not (description or price):
                continue
            items.append(
                {
                    "description": _extracted(description),
                    "quantity": _extracted(quantity, normalize_amount(_text(quantity)) if quantity else None),
                    "amount": _extracted(price, normalize_amount(_text(price)) if price else None),
                }
            )
            if len(items) >= MAX_LINE_ITEMS:
                return items
    return items


def parse_analyze_expense(response: dict) -> dict:
    documents = response.get("ExpenseDocuments") or []
    warnings: list[str] = []
    if len(documents) > 1:
        warnings.append("MULTIPLE_RECEIPTS")
    document = documents[0] if documents else {}
    fields = document.get("SummaryFields") or []

    merchant_field = _best(fields, ("VENDOR_NAME",))
    date_field = _best(fields, ("INVOICE_RECEIPT_DATE",))
    total_field = _best(fields, ("TOTAL", "AMOUNT_PAID"))

    currency = _currency(fields, total_field)
    # Only the day/month order is inferred, and the date is flagged as ambiguous whenever it matters.
    date_info = normalize_date(_text(date_field) if date_field else None, prefer_month_first=currency["value"] in (None, "USD"))
    date = _extracted(date_field, date_info["value"])
    date["ambiguous"] = date_info["ambiguous"]
    if date_field and not date_info["value"]:
        date["unparsed"] = True

    total = _extracted(total_field, normalize_amount(_text(total_field)) if total_field else None)
    if total_field and not total["value"]:
        total["unparsed"] = True
    if total_field and _type(total_field) == "AMOUNT_PAID":
        total["label"] = "AMOUNT_PAID"

    extraction = {
        "merchant": _extracted(merchant_field),
        "date": date,
        "total": total,
        "currency": currency,
        "lineItems": _line_items(document),
        "pages": (response.get("DocumentMetadata") or {}).get("Pages"),
        "warnings": warnings,
    }
    return extraction


def has_useful_data(extraction: dict) -> bool:
    return bool(
        extraction["merchant"]["value"]
        or extraction["date"]["raw"]
        or extraction["total"]["raw"]
        or extraction["lineItems"]
    )


def initial_draft(extraction: dict, category: str | None) -> dict:
    """The editable draft starts as a copy of what Textract found, plus the category suggestion."""
    return {
        "merchant": extraction["merchant"]["value"],
        "date": extraction["date"]["value"],
        "total": extraction["total"]["value"],
        "currency": extraction["currency"]["value"],
        "category": category,
        "lineItems": [
            {
                "description": item["description"]["value"],
                "quantity": item["quantity"]["value"],
                "amount": item["amount"]["value"],
            }
            for item in extraction["lineItems"]
        ],
    }
