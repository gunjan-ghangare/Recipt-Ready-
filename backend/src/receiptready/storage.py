"""Private S3 storage for receipt files. Keys are always derived from the caller's user ID."""

from __future__ import annotations

from botocore.exceptions import ClientError

from . import aws
from .config import SUPPORTED_UPLOAD_TYPES, load_settings


def receipt_key(user_id: str, expense_id: str, content_type: str) -> str:
    extension = SUPPORTED_UPLOAD_TYPES[content_type]["extension"]
    return f"receipts/{user_id}/{expense_id}/receipt.{extension}"


def assert_owned(user_id: str, key: str) -> None:
    """Defense in depth: never touch an object outside the caller's prefix."""
    if not key.startswith(f"receipts/{user_id}/"):
        raise PermissionError("receipt key outside caller scope")


def presign_upload(key: str, content_type: str) -> dict:
    settings = load_settings()
    # A presigned POST lets S3 itself enforce the exact key, content type, and size limit.
    return aws.s3().generate_presigned_post(
        Bucket=settings.bucket_name,
        Key=key,
        Fields={"Content-Type": content_type},
        Conditions=[
            {"Content-Type": content_type},
            ["content-length-range", 1, settings.max_upload_bytes],
        ],
        ExpiresIn=settings.upload_url_ttl_seconds,
    )


def presign_view(key: str, content_type: str) -> str:
    settings = load_settings()
    return aws.s3().generate_presigned_url(
        "get_object",
        Params={
            "Bucket": settings.bucket_name,
            "Key": key,
            "ResponseContentType": content_type,
            "ResponseContentDisposition": "inline",
            "ResponseCacheControl": "private, max-age=600",
        },
        ExpiresIn=settings.view_url_ttl_seconds,
    )


def head(key: str) -> dict | None:
    try:
        response = aws.s3().head_object(Bucket=load_settings().bucket_name, Key=key)
    except ClientError as exc:
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        # Without s3:ListBucket, S3 reports a missing object as 403 rather than 404.
        if status in (403, 404):
            return None
        raise
    return {"size": response.get("ContentLength", 0), "contentType": response.get("ContentType", "")}


def read_signature(key: str, length: int = 16) -> bytes:
    response = aws.s3().get_object(Bucket=load_settings().bucket_name, Key=key, Range=f"bytes=0-{length - 1}")
    return response["Body"].read()


def matches_signature(content_type: str, prefix: bytes) -> bool:
    return any(prefix.startswith(sig) for sig in SUPPORTED_UPLOAD_TYPES[content_type]["signatures"])


def delete(key: str) -> None:
    aws.s3().delete_object(Bucket=load_settings().bucket_name, Key=key)
