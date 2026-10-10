"""Runtime configuration and product constants."""

from __future__ import annotations

import os
from dataclasses import dataclass

# The only categories ReceiptReady will ever store. Model output is validated against this list.
ALLOWED_CATEGORIES: tuple[str, ...] = ("Travel", "Meals", "Software", "Supplies", "Other")

# Amazon Textract synchronous operations (AnalyzeExpense) accept JPEG, PNG, PDF, and TIFF files up to
# 10 MB, PDF/TIFF limited to one page, images up to 10,000 px per side.
# https://docs.aws.amazon.com/textract/latest/dg/limits-document.html
# ReceiptReady accepts the subset that browsers can also preview next to the draft: JPEG, PNG, PDF.
TEXTRACT_SYNC_MAX_BYTES = 10 * 1024 * 1024

SUPPORTED_UPLOAD_TYPES: dict[str, dict] = {
    "image/jpeg": {"extension": "jpg", "signatures": (b"\xff\xd8\xff",)},
    "image/png": {"extension": "png", "signatures": (b"\x89PNG\r\n\x1a\n",)},
    "application/pdf": {"extension": "pdf", "signatures": (b"%PDF-",)},
}

# Expense lifecycle.
STATUS_AWAITING_UPLOAD = "AWAITING_UPLOAD"
STATUS_PROCESSING = "PROCESSING"
STATUS_NEEDS_REVIEW = "NEEDS_REVIEW"
STATUS_APPROVED = "APPROVED"
STATUS_FAILED = "FAILED"

STAGE_QUEUED = "QUEUED"
STAGE_READING = "READING"
STAGE_CATEGORIZING = "CATEGORIZING"


@dataclass(frozen=True)
class Settings:
    region: str
    table_name: str
    bucket_name: str
    worker_function_name: str
    bedrock_model_id: str
    max_upload_bytes: int
    upload_url_ttl_seconds: int
    view_url_ttl_seconds: int
    pending_upload_ttl_seconds: int
    stale_processing_seconds: int


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def load_settings() -> Settings:
    max_upload = min(_int_env("MAX_UPLOAD_BYTES", TEXTRACT_SYNC_MAX_BYTES), TEXTRACT_SYNC_MAX_BYTES)
    return Settings(
        region=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1",
        table_name=os.environ.get("TABLE_NAME", ""),
        bucket_name=os.environ.get("BUCKET_NAME", ""),
        worker_function_name=os.environ.get("WORKER_FUNCTION_NAME", ""),
        bedrock_model_id=os.environ.get("BEDROCK_MODEL_ID", "").strip(),
        max_upload_bytes=max_upload,
        upload_url_ttl_seconds=_int_env("UPLOAD_URL_TTL_SECONDS", 600),
        view_url_ttl_seconds=_int_env("VIEW_URL_TTL_SECONDS", 900),
        pending_upload_ttl_seconds=_int_env("PENDING_UPLOAD_TTL_SECONDS", 24 * 3600),
        stale_processing_seconds=_int_env("STALE_PROCESSING_SECONDS", 180),
    )
