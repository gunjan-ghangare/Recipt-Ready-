"""Request validation. Everything that comes from the browser is checked here."""

from __future__ import annotations

import os
import re
import time
import uuid
from datetime import date
from decimal import Decimal, InvalidOperation

from .config import ALLOWED_CATEGORIES, SUPPORTED_UPLOAD_TYPES
from .errors import AppError
from .normalize import today_utc

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_AMOUNT = re.compile(r"^\d{1,8}(\.\d{1,3})?$")
_QUANTITY = re.compile(r"^\d{1,6}(\.\d{1,3})?$")
_CURRENCY = re.compile(r"^[A-Z]{3}$")
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

MAX_MERCHANT = 120
MAX_DESCRIPTION = 200
MAX_LINE_ITEMS = 100


def new_expense_id() -> str:
    """UUIDv7-style ID: time-ordered so DynamoDB returns newest expenses first."""
    millis = int(time.time() * 1000) & ((1 << 48) - 1)
    rand = int.from_bytes(os.urandom(10), "big")
    value = (millis << 80) | (0x7 << 76) | ((rand >> 68) << 64) | (0b10 << 62) | (rand & ((1 << 62) - 1))
    return str(uuid.UUID(int=value))


def require_expense_id(raw: str | None) -> str:
    if not raw or not _UUID.match(raw):
        raise AppError("NOT_FOUND", 404)
    return raw


def _clean_text(value, max_len: int, field: str, errors: list[dict]) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        errors.append({"field": field, "message": "Enter text."})
        return None
    text = _CONTROL_CHARS.sub("", value).strip()
    if len(text) > max_len:
        errors.append({"field": field, "message": f"Keep this under {max_len} characters."})
        return None
    return text or None


def validate_upload_request(body: dict, max_bytes: int) -> dict:
    file_name = body.get("fileName")
    content_type = str(body.get("contentType") or "").lower().strip()
    size = body.get("size")
    lower_name = file_name.lower() if isinstance(file_name, str) else ""

    if content_type in {"image/heic", "image/heif"} or lower_name.endswith((".heic", ".heif")):
        raise AppError("HEIC_NOT_SUPPORTED", 415)
    if content_type == "image/tiff" or lower_name.endswith((".tif", ".tiff")):
        raise AppError("TIFF_NOT_SUPPORTED", 415)
    if content_type not in SUPPORTED_UPLOAD_TYPES:
        raise AppError("UNSUPPORTED_FILE_TYPE", 415)
    if isinstance(size, bool) or not isinstance(size, int):
        raise AppError("INVALID_REQUEST", 400)
    if size <= 0:
        raise AppError("FILE_EMPTY", 400)
    if size > max_bytes:
        raise AppError("FILE_TOO_LARGE", 413)

    errors: list[dict] = []
    name = _clean_text(file_name if isinstance(file_name, str) else None, 200, "fileName", errors)
    # Keep only a display-safe file name; it is never used to build storage keys.
    safe_name = re.sub(r"[^\w.\- ()]", "_", name or "receipt")[:120]
    return {"fileName": safe_name, "contentType": content_type, "size": size}


def _amount(value, field: str, errors: list[dict], pattern=_AMOUNT) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        errors.append({"field": field, "message": "Enter a number like 12.50."})
        return None
    text = str(value).strip().replace(",", "")
    if not pattern.match(text):
        errors.append({"field": field, "message": "Enter a number like 12.50."})
        return None
    try:
        return format(Decimal(text), "f")
    except InvalidOperation:
        errors.append({"field": field, "message": "Enter a number like 12.50."})
        return None


def _date(value, field: str, errors: list[dict]) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not _ISO_DATE.match(value):
        errors.append({"field": field, "message": "Enter a date like 2026-03-14."})
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        errors.append({"field": field, "message": "That date doesn't exist."})
        return None
    if parsed.year < 1990 or parsed > date(today_utc().year + 1, 12, 31):
        errors.append({"field": field, "message": "Check the year on this date."})
        return None
    return parsed.isoformat()


def validate_draft(body: dict) -> dict:
    """Validate an edited draft. Fields may be empty while the expense is still a draft."""
    if not isinstance(body, dict):
        raise AppError("INVALID_REQUEST", 400)
    errors: list[dict] = []
    draft: dict = {
        "merchant": _clean_text(body.get("merchant"), MAX_MERCHANT, "merchant", errors),
        "date": _date(body.get("date"), "date", errors),
        "total": _amount(body.get("total"), "total", errors),
        "currency": None,
        "category": None,
        "lineItems": [],
    }

    currency = body.get("currency")
    if currency not in (None, ""):
        code = str(currency).strip().upper()
        if _CURRENCY.match(code):
            draft["currency"] = code
        else:
            errors.append({"field": "currency", "message": "Use a 3-letter currency code like USD."})

    category = body.get("category")
    if category not in (None, ""):
        if category in ALLOWED_CATEGORIES:
            draft["category"] = category
        else:
            errors.append({"field": "category", "message": "Choose one of the listed categories."})

    items = body.get("lineItems") or []
    if not isinstance(items, list) or len(items) > MAX_LINE_ITEMS:
        errors.append({"field": "lineItems", "message": f"Keep line items under {MAX_LINE_ITEMS}."})
        items = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            errors.append({"field": f"lineItems.{index}", "message": "Line item is not valid."})
            continue
        line = {
            "description": _clean_text(item.get("description"), MAX_DESCRIPTION, f"lineItems.{index}.description", errors),
            "quantity": _amount(item.get("quantity"), f"lineItems.{index}.quantity", errors, _QUANTITY),
            "amount": _amount(item.get("amount"), f"lineItems.{index}.amount", errors),
        }
        if any(line.values()):
            draft["lineItems"].append(line)

    if errors:
        raise AppError("VALIDATION_FAILED", 422, errors)
    return draft


def validate_for_approval(draft: dict) -> None:
    """An approved expense must be complete. The user fixes these before approving."""
    errors: list[dict] = []
    if not draft.get("merchant"):
        errors.append({"field": "merchant", "message": "Add the merchant name."})
    if not draft.get("date"):
        errors.append({"field": "date", "message": "Add the receipt date."})
    total = draft.get("total")
    if not total:
        errors.append({"field": "total", "message": "Add the total amount."})
    elif Decimal(total) <= 0:
        errors.append({"field": "total", "message": "The total must be more than zero."})
    if not draft.get("currency"):
        errors.append({"field": "currency", "message": "Add the currency."})
    if not draft.get("category"):
        errors.append({"field": "category", "message": "Choose a category."})
    if errors:
        raise AppError("VALIDATION_FAILED", 422, errors)
