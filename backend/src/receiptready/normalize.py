"""Deterministic normalization of text that Amazon Textract extracted.

These helpers only reformat what is printed on the receipt (for example "03/14/26" -> "2026-03-14").
They never fill in values that aren't there.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation

_MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
    "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9,
    "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}

_ISO = re.compile(r"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b")
_NUMERIC = re.compile(r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b")
_DAY_MONTH_NAME = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?[\s\-./,]*([A-Za-z]{3,9})\.?[\s\-./,']*(\d{2}|\d{4})\b")
_MONTH_NAME_DAY = re.compile(r"\b([A-Za-z]{3,9})\.?[\s\-./]*(\d{1,2})(?:st|nd|rd|th)?[\s,\-./']*(\d{2}|\d{4})\b")


def _year(raw: str) -> int:
    value = int(raw)
    return 2000 + value if len(raw) == 2 else value


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def normalize_date(text: str | None, prefer_month_first: bool = True) -> dict:
    """Parse a printed receipt date.

    Returns {"value": "YYYY-MM-DD" | None, "ambiguous": bool}. Ambiguous means the day and month
    could be swapped (for example 03/04/2026); the user is asked to confirm those.
    """
    result = {"value": None, "ambiguous": False}
    if not text:
        return result
    cleaned = text.strip()

    match = _ISO.search(cleaned)
    if match:
        parsed = _safe_date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        if parsed:
            result["value"] = parsed.isoformat()
        return result

    for pattern, order in ((_DAY_MONTH_NAME, "dmy"), (_MONTH_NAME_DAY, "mdy")):
        match = pattern.search(cleaned)
        if not match:
            continue
        if order == "dmy":
            day_raw, month_raw, year_raw = match.groups()
        else:
            month_raw, day_raw, year_raw = match.groups()
        month = _MONTHS.get(month_raw.lower())
        if month:
            parsed = _safe_date(_year(year_raw), month, int(day_raw))
            if parsed:
                result["value"] = parsed.isoformat()
                return result

    match = _NUMERIC.search(cleaned)
    if match:
        first, second, year_raw = int(match.group(1)), int(match.group(2)), match.group(3)
        year = _year(year_raw)
        month_first = _safe_date(year, first, second)
        day_first = _safe_date(year, second, first)
        if month_first and day_first and first != second:
            result["ambiguous"] = True
            chosen = month_first if prefer_month_first else day_first
        else:
            chosen = month_first or day_first
        if chosen:
            result["value"] = chosen.isoformat()
    return result


_AMOUNT_CHARS = re.compile(r"[^0-9.,\-]")


def normalize_amount(text: str | None) -> str | None:
    """Turn printed money text like "$1,234.50" or "12,50 EUR" into a plain decimal string."""
    if not text:
        return None
    raw = _AMOUNT_CHARS.sub("", text)
    raw = raw.strip("-.,")
    if not raw or not any(ch.isdigit() for ch in raw):
        return None

    has_dot, has_comma = "." in raw, "," in raw
    if has_dot and has_comma:
        decimal_sep = "." if raw.rfind(".") > raw.rfind(",") else ","
        thousands_sep = "," if decimal_sep == "." else "."
        raw = raw.replace(thousands_sep, "").replace(decimal_sep, ".")
    elif has_comma:
        head, _, tail = raw.rpartition(",")
        if len(tail) == 3 and raw.count(",") >= 1 and head:
            raw = raw.replace(",", "")  # 1,234 -> thousands separator
        else:
            raw = head.replace(",", "") + "." + tail
    elif has_dot and raw.count(".") > 1:
        head, _, tail = raw.rpartition(".")
        raw = head.replace(".", "") + ("." + tail if len(tail) != 3 else tail)

    try:
        value = Decimal(raw)
    except InvalidOperation:
        return None
    if value < 0 or value >= Decimal("100000000"):
        return None
    return format(value, "f")


def today_utc() -> date:
    return datetime.now(timezone.utc).date()
