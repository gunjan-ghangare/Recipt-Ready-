"""User-facing error codes and messages.

Messages are written for the person using the app: they say what happened and what to do next,
and never include stack traces, AWS resource names, or receipt contents.
"""

from __future__ import annotations

ERROR_MESSAGES: dict[str, str] = {
    # Upload and file validation
    "UNSUPPORTED_FILE_TYPE": "ReceiptReady accepts JPEG or PNG photos and single-page PDFs.",
    "HEIC_NOT_SUPPORTED": (
        "HEIC photos can't be read yet. Export the photo as JPEG (on iPhone: Settings > Camera > "
        "Formats > Most Compatible) and upload it again."
    ),
    "TIFF_NOT_SUPPORTED": "TIFF files aren't supported here. Save the receipt as JPEG, PNG, or PDF and try again.",
    "FILE_TOO_LARGE": "This file is larger than 10 MB. Try a smaller photo or a compressed PDF.",
    "FILE_EMPTY": "This file is empty. Choose the receipt file again.",
    "FILE_CONTENT_MISMATCH": "This file doesn't look like a valid JPEG, PNG, or PDF. Try exporting it again.",
    "UPLOAD_NOT_FOUND": "We didn't receive your file. Check your connection and upload the receipt again.",
    # Extraction
    "RECEIPT_UNREADABLE": (
        "We couldn't read this receipt. Try a sharper, well-lit photo with the whole receipt in frame "
        "and the text in focus."
    ),
    "UNSUPPORTED_DOCUMENT": (
        "This file couldn't be processed. Upload a JPEG or PNG photo, or a single-page PDF that isn't "
        "password-protected."
    ),
    "SERVICE_BUSY": "The receipt reader is busy right now. Wait a minute and try again.",
    "SERVICE_UNAVAILABLE": "Receipt reading is temporarily unavailable. Try again in a few minutes.",
    "SERVICE_NOT_CONFIGURED": (
        "Receipt reading isn't set up for this deployment yet. If you run this app, check the AWS "
        "setup steps in the README."
    ),
    "PROCESSING_FAILED": "Something went wrong while reading this receipt. Try again, or upload a different photo.",
    # Requests
    "UNAUTHORIZED": "Your session has ended. Sign in again to continue.",
    "NOT_FOUND": "We couldn't find that expense. It may have been deleted.",
    "ROUTE_NOT_FOUND": "That action isn't available.",
    "INVALID_REQUEST": "The request couldn't be understood. Refresh the page and try again.",
    "VALIDATION_FAILED": "Some fields need attention before this can be saved.",
    "ALREADY_PROCESSING": "This receipt is already being read.",
    "ALREADY_PROCESSED": "This receipt has already been read.",
    "NOT_A_DRAFT": "Only drafts can be changed. Approved expenses are read-only.",
    "ALREADY_APPROVED": "This expense is already approved. Delete it instead if it shouldn't be kept.",
    "CHANGED_ELSEWHERE": "This expense changed in another window. Refresh to see the latest version.",
    "INTERNAL_ERROR": "Something went wrong on our side. Try again in a moment.",
}

# Failure codes a user can usefully retry without uploading a new file.
RETRYABLE_FAILURES = {"SERVICE_BUSY", "SERVICE_UNAVAILABLE", "PROCESSING_FAILED", "SERVICE_NOT_CONFIGURED"}


def message_for(code: str) -> str:
    return ERROR_MESSAGES.get(code, ERROR_MESSAGES["INTERNAL_ERROR"])


class AppError(Exception):
    """An expected, user-presentable error."""

    def __init__(self, code: str, status: int = 400, field_errors: list[dict] | None = None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.field_errors = field_errors or []

    def to_body(self) -> dict:
        body: dict = {"code": self.code, "message": message_for(self.code)}
        if self.field_errors:
            body["fields"] = self.field_errors
        return {"error": body}
