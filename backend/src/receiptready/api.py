"""HTTP API Lambda handler (API Gateway HTTP API, payload format 2.0).

Every route requires a Cognito access token, validated by the API Gateway JWT authorizer.
The user ID always comes from the verified `sub` claim, never from the request body or path.
"""

from __future__ import annotations

import base64
import json
import logging
from datetime import datetime, timedelta, timezone

from botocore.exceptions import BotoCoreError, ClientError

from . import aws, repository, storage
from .config import (
    ALLOWED_CATEGORIES,
    STATUS_APPROVED,
    STATUS_AWAITING_UPLOAD,
    STATUS_FAILED,
    STATUS_NEEDS_REVIEW,
    STATUS_PROCESSING,
    load_settings,
)
from .errors import RETRYABLE_FAILURES, AppError, message_for
from .validation import (
    new_expense_id,
    require_expense_id,
    validate_draft,
    validate_for_approval,
    validate_upload_request,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

MAX_BODY_BYTES = 64 * 1024
DRAFT_STATUSES = (STATUS_AWAITING_UPLOAD, STATUS_PROCESSING, STATUS_NEEDS_REVIEW, STATUS_FAILED)


# ---------------------------------------------------------------- helpers


def _response(status: int, body: dict | None = None) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
        "body": json.dumps(body) if body is not None else "",
    }


def _user_id(event: dict) -> str:
    claims = (((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt") or {}).get("claims") or {}
    sub = claims.get("sub")
    if not sub or claims.get("token_use", "access") != "access":
        raise AppError("UNAUTHORIZED", 401)
    return sub


def _body(event: dict) -> dict:
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            raise AppError("INVALID_REQUEST", 400) from None
    if len(raw.encode("utf-8")) > MAX_BODY_BYTES:
        raise AppError("INVALID_REQUEST", 413)
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise AppError("INVALID_REQUEST", 400) from None
    if not isinstance(parsed, dict):
        raise AppError("INVALID_REQUEST", 400)
    return parsed


def _path_id(event: dict) -> str:
    return require_expense_id((event.get("pathParameters") or {}).get("id"))


def serialize(item: dict, include_view_url: bool = False) -> dict:
    receipt = item.get("receipt") or {}
    out = {
        "id": item["expenseId"],
        "status": item["status"],
        "stage": item.get("stage"),
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
        "approvedAt": item.get("approvedAt"),
        "source": "AWS",
        "receipt": {
            "fileName": receipt.get("fileName"),
            "contentType": receipt.get("contentType"),
            "size": receipt.get("size"),
        },
        "draft": item.get("draft"),
        "extraction": item.get("extraction"),
        "suggestion": item.get("suggestion"),
        "allowedCategories": list(ALLOWED_CATEGORIES),
    }
    if item.get("error"):
        code = item["error"].get("code", "PROCESSING_FAILED")
        out["error"] = {"code": code, "message": message_for(code), "retryable": code in RETRYABLE_FAILURES}
    if include_view_url and receipt.get("key") and item["status"] != STATUS_AWAITING_UPLOAD:
        storage.assert_owned(item["userId"], receipt["key"])
        out["receipt"]["viewUrl"] = storage.presign_view(receipt["key"], receipt["contentType"])
    return out


def _delete_receipt_file(user_id: str, item: dict) -> None:
    key = (item.get("receipt") or {}).get("key")
    if not key:
        return
    storage.assert_owned(user_id, key)
    try:
        storage.delete(key)
    except (ClientError, BotoCoreError) as exc:
        # The record is already gone; log for follow-up without failing the user's request.
        logger.error("receipt_delete_failed", extra={"expenseId": item.get("expenseId"), "errorType": type(exc).__name__})


# ---------------------------------------------------------------- routes


def create_upload(event: dict, user_id: str) -> dict:
    settings = load_settings()
    request = validate_upload_request(_body(event), settings.max_upload_bytes)
    expense_id = new_expense_id()
    key = storage.receipt_key(user_id, expense_id, request["contentType"])
    receipt = {**request, "key": key}
    item = repository.create_pending(user_id, expense_id, receipt, settings.pending_upload_ttl_seconds)
    item["userId"] = user_id
    upload = storage.presign_upload(key, request["contentType"])
    return _response(
        201,
        {
            "expense": serialize(item),
            "upload": {
                "url": upload["url"],
                "fields": upload["fields"],
                "maxBytes": settings.max_upload_bytes,
                "expiresInSeconds": settings.upload_url_ttl_seconds,
            },
        },
    )


def process_receipt(event: dict, user_id: str) -> dict:
    settings = load_settings()
    expense_id = _path_id(event)
    item = repository.get_or_404(user_id, expense_id)

    if item["status"] in (STATUS_NEEDS_REVIEW, STATUS_APPROVED):
        raise AppError("ALREADY_PROCESSED", 409)

    receipt = item.get("receipt") or {}
    key, content_type = receipt.get("key"), receipt.get("contentType")
    storage.assert_owned(user_id, key)

    if item["status"] != STATUS_PROCESSING:
        meta = storage.head(key)
        if meta is None:
            raise AppError("UPLOAD_NOT_FOUND", 409)
        failure = None
        if meta["size"] > settings.max_upload_bytes:
            failure = "FILE_TOO_LARGE"
        elif not storage.matches_signature(content_type, storage.read_signature(key)):
            failure = "FILE_CONTENT_MISMATCH"
        if failure:
            storage.delete(key)
            repository.mark_failed(user_id, expense_id, failure, (STATUS_AWAITING_UPLOAD, STATUS_FAILED))
            raise AppError(failure, 422)

    stale_before = (datetime.now(timezone.utc) - timedelta(seconds=settings.stale_processing_seconds)).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    try:
        item = repository.mark_processing(user_id, expense_id, stale_before)
    except AppError as exc:
        if exc.code == "ALREADY_PROCESSING":
            current = repository.get_or_404(user_id, expense_id)
            if current["status"] == STATUS_PROCESSING:
                return _response(202, {"expense": serialize(current)})
        raise

    try:
        aws.lambda_client().invoke(
            FunctionName=settings.worker_function_name,
            InvocationType="Event",
            Payload=json.dumps({"userId": user_id, "expenseId": expense_id}).encode(),
        )
    except (ClientError, BotoCoreError) as exc:
        logger.error("worker_invoke_failed", extra={"expenseId": expense_id, "errorType": type(exc).__name__})
        repository.mark_failed(user_id, expense_id, "SERVICE_UNAVAILABLE")
        raise AppError("SERVICE_UNAVAILABLE", 503) from None

    return _response(202, {"expense": serialize(item)})


def list_expenses(event: dict, user_id: str) -> dict:
    params = event.get("queryStringParameters") or {}
    try:
        limit = max(1, min(int(params.get("limit", 50)), 100))
    except ValueError:
        raise AppError("INVALID_REQUEST", 400) from None
    items, next_token = repository.list_for_user(user_id, limit, params.get("nextToken"))
    return _response(200, {"expenses": [serialize(i) for i in items], "nextToken": next_token})


def get_expense(event: dict, user_id: str) -> dict:
    item = repository.get_or_404(user_id, _path_id(event))
    return _response(200, {"expense": serialize(item, include_view_url=True)})


def update_expense(event: dict, user_id: str) -> dict:
    expense_id = _path_id(event)
    draft = validate_draft(_body(event).get("draft") or {})
    item = repository.update_draft(user_id, expense_id, draft)
    return _response(200, {"expense": serialize(item, include_view_url=True)})


def approve_expense(event: dict, user_id: str) -> dict:
    expense_id = _path_id(event)
    body = _body(event)
    if "draft" in body:
        draft = validate_draft(body["draft"] or {})
    else:
        current = repository.get_or_404(user_id, expense_id)
        if current["status"] != STATUS_NEEDS_REVIEW:
            raise AppError("ALREADY_APPROVED" if current["status"] == STATUS_APPROVED else "NOT_A_DRAFT", 409)
        draft = validate_draft(current.get("draft") or {})
    validate_for_approval(draft)
    # Approval only happens here, in response to the user's explicit request.
    item = repository.approve(user_id, expense_id, draft)
    logger.info("expense_approved", extra={"expenseId": expense_id})
    return _response(200, {"expense": serialize(item, include_view_url=True)})


def reject_expense(event: dict, user_id: str) -> dict:
    expense_id = _path_id(event)
    old = repository.delete(user_id, expense_id, DRAFT_STATUSES)
    _delete_receipt_file(user_id, old)
    return _response(200, {"deleted": True, "id": expense_id})


def delete_expense(event: dict, user_id: str) -> dict:
    expense_id = _path_id(event)
    old = repository.delete(user_id, expense_id, (STATUS_APPROVED, *DRAFT_STATUSES))
    _delete_receipt_file(user_id, old)
    return _response(200, {"deleted": True, "id": expense_id})


ROUTES = {
    "POST /receipts": create_upload,
    "POST /receipts/{id}/process": process_receipt,
    "GET /expenses": list_expenses,
    "GET /expenses/{id}": get_expense,
    "PATCH /expenses/{id}": update_expense,
    "POST /expenses/{id}/approve": approve_expense,
    "POST /expenses/{id}/reject": reject_expense,
    "DELETE /expenses/{id}": delete_expense,
}


def handler(event: dict, context) -> dict:
    route_key = event.get("routeKey", "")
    route = ROUTES.get(route_key)
    try:
        if route is None:
            raise AppError("ROUTE_NOT_FOUND", 404)
        return route(event, _user_id(event))
    except AppError as exc:
        if exc.status >= 500:
            logger.warning("request_failed", extra={"route": route_key, "code": exc.code})
        return _response(exc.status, exc.to_body())
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "Unknown")
        logger.error("aws_error", extra={"route": route_key, "errorCode": code})
        throttled = code in {"ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded"}
        app_error = AppError("SERVICE_BUSY" if throttled else "INTERNAL_ERROR", 503 if throttled else 500)
        return _response(app_error.status, app_error.to_body())
    except BotoCoreError as exc:
        # Missing credentials, unreachable endpoints, timeouts.
        logger.error("aws_unavailable", extra={"route": route_key, "errorType": type(exc).__name__})
        app_error = AppError("SERVICE_UNAVAILABLE", 503)
        return _response(app_error.status, app_error.to_body())
    except Exception as exc:  # noqa: BLE001 - last-resort guard; never leak details to the client
        logger.error("unhandled_error", extra={"route": route_key, "errorType": type(exc).__name__})
        app_error = AppError("INTERNAL_ERROR", 500)
        return _response(app_error.status, app_error.to_body())
