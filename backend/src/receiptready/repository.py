"""DynamoDB access. The partition key is the Cognito user ID, so every read and write is
scoped to the signed-in user by construction."""

from __future__ import annotations

import base64
import json
import time
from datetime import datetime, timezone
from decimal import Decimal

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

from . import aws
from .config import (
    STAGE_QUEUED,
    STATUS_APPROVED,
    STATUS_AWAITING_UPLOAD,
    STATUS_FAILED,
    STATUS_NEEDS_REVIEW,
    STATUS_PROCESSING,
)
from .errors import AppError
from .validation import require_expense_id


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def to_dynamo(value):
    """DynamoDB rejects Python floats; store them as Decimal."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: to_dynamo(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_dynamo(v) for v in value]
    return value


def from_dynamo(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: from_dynamo(v) for k, v in value.items()}
    if isinstance(value, list):
        return [from_dynamo(v) for v in value]
    return value


def _key(user_id: str, expense_id: str) -> dict:
    return {"userId": user_id, "expenseId": expense_id}


def _is_conditional_failure(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"


def create_pending(user_id: str, expense_id: str, receipt: dict, ttl_seconds: int) -> dict:
    timestamp = now_iso()
    item = {
        "userId": user_id,
        "expenseId": expense_id,
        "status": STATUS_AWAITING_UPLOAD,
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "receipt": receipt,
        # Upload intents that are never completed expire automatically (DynamoDB TTL).
        "expiresAt": int(time.time()) + ttl_seconds,
    }
    aws.dynamodb_table().put_item(Item=to_dynamo(item), ConditionExpression=Attr("expenseId").not_exists())
    return item


def get(user_id: str, expense_id: str) -> dict | None:
    response = aws.dynamodb_table().get_item(Key=_key(user_id, expense_id), ConsistentRead=True)
    item = response.get("Item")
    return from_dynamo(item) if item else None


def get_or_404(user_id: str, expense_id: str) -> dict:
    item = get(user_id, expense_id)
    expired_intent = bool(item) and item.get("status") == STATUS_AWAITING_UPLOAD and item.get("expiresAt", 0) < time.time()
    if not item or expired_intent:
        raise AppError("NOT_FOUND", 404)
    return item


def _encode_token(expense_id: str) -> str:
    return base64.urlsafe_b64encode(json.dumps({"e": expense_id}).encode()).decode().rstrip("=")


def _decode_token(token: str) -> str:
    try:
        padded = token + "=" * (-len(token) % 4)
        expense_id = json.loads(base64.urlsafe_b64decode(padded.encode()))["e"]
        return require_expense_id(expense_id)
    except (ValueError, KeyError, TypeError, AppError):
        raise AppError("INVALID_REQUEST", 400) from None


def list_for_user(user_id: str, limit: int, next_token: str | None) -> tuple[list[dict], str | None]:
    kwargs = {
        "KeyConditionExpression": Key("userId").eq(user_id),
        "FilterExpression": Attr("status").ne(STATUS_AWAITING_UPLOAD),
        "ScanIndexForward": False,  # IDs are time-ordered: newest first
        "Limit": limit,
    }
    if next_token:
        # Only the sort key comes from the client; the partition key is always the caller's.
        kwargs["ExclusiveStartKey"] = _key(user_id, _decode_token(next_token))
    response = aws.dynamodb_table().query(**kwargs)
    last = response.get("LastEvaluatedKey")
    return [from_dynamo(i) for i in response.get("Items", [])], _encode_token(last["expenseId"]) if last else None


def mark_processing(user_id: str, expense_id: str, stale_before_iso: str) -> dict:
    """Move an uploaded (or failed / stuck) receipt into PROCESSING exactly once."""
    try:
        response = aws.dynamodb_table().update_item(
            Key=_key(user_id, expense_id),
            UpdateExpression="SET #s = :processing, stage = :queued, updatedAt = :now REMOVE expiresAt, #e",
            ConditionExpression=(
                "attribute_exists(expenseId) AND (#s IN (:awaiting, :failed) OR (#s = :processing AND updatedAt < :stale))"
            ),
            ExpressionAttributeNames={"#s": "status", "#e": "error"},
            ExpressionAttributeValues={
                ":processing": STATUS_PROCESSING,
                ":queued": STAGE_QUEUED,
                ":awaiting": STATUS_AWAITING_UPLOAD,
                ":failed": STATUS_FAILED,
                ":stale": stale_before_iso,
                ":now": now_iso(),
            },
            ReturnValues="ALL_NEW",
        )
    except ClientError as exc:
        if _is_conditional_failure(exc):
            raise AppError("ALREADY_PROCESSING", 409) from None
        raise
    return from_dynamo(response["Attributes"])


def set_stage(user_id: str, expense_id: str, stage: str) -> None:
    try:
        aws.dynamodb_table().update_item(
            Key=_key(user_id, expense_id),
            UpdateExpression="SET stage = :stage, updatedAt = :now",
            ConditionExpression="#s = :processing",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":stage": stage, ":processing": STATUS_PROCESSING, ":now": now_iso()},
        )
    except ClientError as exc:
        if not _is_conditional_failure(exc):
            raise


def save_extraction(user_id: str, expense_id: str, extraction: dict, draft: dict, suggestion: dict) -> bool:
    """Store Textract results and the editable draft. Returns False if the draft was discarded meanwhile."""
    try:
        aws.dynamodb_table().update_item(
            Key=_key(user_id, expense_id),
            UpdateExpression=(
                "SET #s = :review, extraction = :extraction, draft = :draft, suggestion = :suggestion, "
                "updatedAt = :now, extractedAt = :now REMOVE stage"
            ),
            ConditionExpression="#s = :processing",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues=to_dynamo(
                {
                    ":review": STATUS_NEEDS_REVIEW,
                    ":processing": STATUS_PROCESSING,
                    ":extraction": extraction,
                    ":draft": draft,
                    ":suggestion": suggestion,
                    ":now": now_iso(),
                }
            ),
        )
    except ClientError as exc:
        if _is_conditional_failure(exc):
            return False
        raise
    return True


def mark_failed(user_id: str, expense_id: str, code: str, from_statuses: tuple[str, ...] = (STATUS_PROCESSING,)) -> None:
    names = {f":from{i}": status for i, status in enumerate(from_statuses)}
    try:
        aws.dynamodb_table().update_item(
            Key=_key(user_id, expense_id),
            UpdateExpression="SET #s = :failed, #e = :error, updatedAt = :now REMOVE stage, expiresAt",
            ConditionExpression=f"#s IN ({', '.join(names)})",
            ExpressionAttributeNames={"#s": "status", "#e": "error"},
            ExpressionAttributeValues={":failed": STATUS_FAILED, ":error": {"code": code}, ":now": now_iso(), **names},
        )
    except ClientError as exc:
        if not _is_conditional_failure(exc):
            raise


def _update_draft(user_id: str, expense_id: str, draft: dict, approve: bool) -> dict:
    timestamp = now_iso()
    expression = "SET draft = :draft, updatedAt = :now"
    values = {":draft": draft, ":now": timestamp, ":review": STATUS_NEEDS_REVIEW}
    if approve:
        expression += ", #s = :approved, approvedAt = :now"
        values[":approved"] = STATUS_APPROVED
    try:
        response = aws.dynamodb_table().update_item(
            Key=_key(user_id, expense_id),
            UpdateExpression=expression,
            ConditionExpression="#s = :review",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues=to_dynamo(values),
            ReturnValues="ALL_NEW",
        )
    except ClientError as exc:
        if _is_conditional_failure(exc):
            current = get(user_id, expense_id)
            if not current:
                raise AppError("NOT_FOUND", 404) from None
            raise AppError("ALREADY_APPROVED" if current["status"] == STATUS_APPROVED else "NOT_A_DRAFT", 409) from None
        raise
    return from_dynamo(response["Attributes"])


def update_draft(user_id: str, expense_id: str, draft: dict) -> dict:
    return _update_draft(user_id, expense_id, draft, approve=False)


def approve(user_id: str, expense_id: str, draft: dict) -> dict:
    return _update_draft(user_id, expense_id, draft, approve=True)


def delete(user_id: str, expense_id: str, allowed_statuses: tuple[str, ...]) -> dict:
    names = {f":st{i}": status for i, status in enumerate(allowed_statuses)}
    try:
        response = aws.dynamodb_table().delete_item(
            Key=_key(user_id, expense_id),
            ConditionExpression=f"attribute_exists(expenseId) AND #s IN ({', '.join(names)})",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues=names,
            ReturnValues="ALL_OLD",
        )
    except ClientError as exc:
        if _is_conditional_failure(exc):
            current = get(user_id, expense_id)
            if not current:
                raise AppError("NOT_FOUND", 404) from None
            raise AppError("ALREADY_APPROVED" if current["status"] == STATUS_APPROVED else "CHANGED_ELSEWHERE", 409) from None
        raise
    return from_dynamo(response.get("Attributes") or {})
