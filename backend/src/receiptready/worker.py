"""Receipt processing worker, invoked asynchronously by the API function.

Flow: Textract AnalyzeExpense -> normalize fields -> Bedrock category suggestion -> save draft.
The result is always a draft (NEEDS_REVIEW) or a failure with an actionable code. Nothing is
ever approved here.

Logging policy: only IDs, stages, durations, and AWS error codes. Never receipt text or model output.
"""

from __future__ import annotations

import logging
import time

from botocore.exceptions import BotoCoreError, ClientError

from . import aws, repository, storage
from .categorizer import suggest_category
from .config import STAGE_CATEGORIZING, STAGE_READING, STATUS_PROCESSING, load_settings
from .textract_parser import has_useful_data, initial_draft, parse_analyze_expense
from .validation import require_expense_id

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Textract error code -> ReceiptReady failure code
_TEXTRACT_FAILURES = {
    "BadDocumentException": "RECEIPT_UNREADABLE",
    "UnsupportedDocumentException": "UNSUPPORTED_DOCUMENT",
    "DocumentTooLargeException": "FILE_TOO_LARGE",
    "InvalidS3ObjectException": "UPLOAD_NOT_FOUND",
    "ProvisionedThroughputExceededException": "SERVICE_BUSY",
    "ThrottlingException": "SERVICE_BUSY",
    "LimitExceededException": "SERVICE_BUSY",
    "AccessDeniedException": "SERVICE_NOT_CONFIGURED",
    "UnrecognizedClientException": "SERVICE_NOT_CONFIGURED",
    "InternalServerError": "SERVICE_UNAVAILABLE",
}


class ProcessingFailure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _analyze(bucket: str, key: str) -> dict:
    try:
        return aws.textract().analyze_expense(Document={"S3Object": {"Bucket": bucket, "Name": key}})
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "Unknown")
        logger.warning("textract_failed", extra={"errorCode": code})
        raise ProcessingFailure(_TEXTRACT_FAILURES.get(code, "SERVICE_UNAVAILABLE")) from None
    except BotoCoreError as exc:
        logger.warning("textract_unavailable", extra={"errorType": type(exc).__name__})
        raise ProcessingFailure("SERVICE_UNAVAILABLE") from None


def process(user_id: str, expense_id: str) -> str:
    settings = load_settings()
    item = repository.get(user_id, expense_id)
    if not item or item.get("status") != STATUS_PROCESSING:
        return "SKIPPED"
    key = (item.get("receipt") or {}).get("key", "")
    storage.assert_owned(user_id, key)

    started = time.monotonic()
    repository.set_stage(user_id, expense_id, STAGE_READING)
    extraction = parse_analyze_expense(_analyze(settings.bucket_name, key))
    if not has_useful_data(extraction):
        raise ProcessingFailure("RECEIPT_UNREADABLE")

    repository.set_stage(user_id, expense_id, STAGE_CATEGORIZING)
    descriptions = [line["description"]["value"] or "" for line in extraction["lineItems"]]
    suggestion = suggest_category(
        aws.bedrock_runtime(), settings.bedrock_model_id, extraction["merchant"]["value"], descriptions
    )

    draft = initial_draft(extraction, suggestion.get("category"))
    saved = repository.save_extraction(user_id, expense_id, extraction, draft, suggestion)
    logger.info(
        "receipt_processed",
        extra={
            "expenseId": expense_id,
            "saved": saved,
            "suggestionStatus": suggestion["status"],
            "lineItemCount": len(extraction["lineItems"]),
            "durationMs": int((time.monotonic() - started) * 1000),
        },
    )
    return "DONE" if saved else "DISCARDED"


def handler(event: dict, context) -> dict:
    try:
        user_id = str(event["userId"])
        expense_id = require_expense_id(event.get("expenseId"))
    except Exception:  # noqa: BLE001
        logger.error("worker_bad_event")
        return {"result": "BAD_EVENT"}

    try:
        return {"result": process(user_id, expense_id)}
    except ProcessingFailure as failure:
        repository.mark_failed(user_id, expense_id, failure.code)
        logger.info("receipt_failed", extra={"expenseId": expense_id, "code": failure.code})
        return {"result": "FAILED", "code": failure.code}
    except Exception as exc:  # noqa: BLE001 - never leave a receipt stuck in PROCESSING
        logger.error("worker_unhandled", extra={"expenseId": expense_id, "errorType": type(exc).__name__})
        try:
            repository.mark_failed(user_id, expense_id, "PROCESSING_FAILED")
        except Exception:  # noqa: BLE001
            logger.error("worker_mark_failed_error", extra={"expenseId": expense_id})
        return {"result": "FAILED", "code": "PROCESSING_FAILED"}
