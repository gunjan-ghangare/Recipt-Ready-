"""Lazily created AWS clients, shared across warm Lambda invocations."""

from __future__ import annotations

from functools import lru_cache

import boto3
from botocore.config import Config

from .config import load_settings


def _config(**extra) -> Config:
    return Config(retries={"max_attempts": 3, "mode": "standard"}, connect_timeout=5, **extra)


@lru_cache(maxsize=1)
def s3():
    region = load_settings().region
    # Regional virtual-hosted endpoint so presigned URLs work immediately for new buckets
    # (avoids redirects that break browser CORS). Checksums only when S3 requires them, so
    # browser form uploads don't need SDK-specific checksum fields.
    return boto3.client(
        "s3",
        region_name=region,
        endpoint_url=f"https://s3.{region}.amazonaws.com",
        config=_config(
            signature_version="s3v4",
            s3={"addressing_style": "virtual"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            read_timeout=10,
        ),
    )


@lru_cache(maxsize=1)
def dynamodb_table():
    settings = load_settings()
    resource = boto3.resource("dynamodb", region_name=settings.region, config=_config(read_timeout=5))
    return resource.Table(settings.table_name)


@lru_cache(maxsize=1)
def lambda_client():
    return boto3.client("lambda", region_name=load_settings().region, config=_config(read_timeout=10))


@lru_cache(maxsize=1)
def textract():
    return boto3.client("textract", region_name=load_settings().region, config=_config(read_timeout=60))


@lru_cache(maxsize=1)
def bedrock_runtime():
    # Short timeouts: a slow category suggestion should never hold up the draft.
    return boto3.client(
        "bedrock-runtime",
        region_name=load_settings().region,
        config=Config(retries={"max_attempts": 2, "mode": "standard"}, connect_timeout=5, read_timeout=20),
    )
