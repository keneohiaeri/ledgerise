# Journal CSV API Guide

This guide describes how an external system can pull durable journal CSV batches from Ledgerise.

## Overview

Ledgerise exports journal entries through a durable file exchange flow:

1. Create a posting batch.
2. Ledgerise claims generated journal entries and stores a CSV artifact.
3. The external system can list batches, inspect a batch, and download the stored CSV later.
4. Ledgerise records each artifact download for audit.

The CSV export endpoint is not the same as the Journal Log UI. The API flow is the authoritative outbound posting/export path and marks included journal entries as `posted`.

## Authentication

Posting file exchange endpoints require an API key with scoped access.

Send the API key in either header:

```http
Authorization: Bearer <api_key>
```

or:

```http
x-api-key: <api_key>
```

Required scopes:

- `posting_batches:create` for creating CSV posting batches.
- `posting_batches:read` for listing and reading posting batches.
- `posting_artifacts:download` for downloading CSV artifacts.

Unauthenticated requests return `401 API_KEY_REQUIRED`. Invalid, disabled, expired, or under-scoped keys return `403 API_KEY_FORBIDDEN`.

## Create A CSV Batch

```http
POST /api/posting-batches/generic-journal-csv
Authorization: Bearer <api_key>
Idempotency-Key: nightly-2026-06-02
Content-Type: application/json
```

```json
{
  "limit": 500
}
```

Ledgerise will claim up to `limit` journal entries where `posting_status = generated`, create a posting batch, store the CSV artifact, mark those entries as `posted`, and return batch metadata plus the CSV content.

To export exact journal entries:

```json
{
  "journal_entry_ids": ["<journal_entry_id>"],
  "limit": 1
}
```

## Idempotency

Always send an `Idempotency-Key` for scheduled exports.

If the same operator, adapter, and idempotency key are used again, Ledgerise returns the original batch and artifact instead of creating another batch.

Example idempotency keys:

```text
nightly-2026-06-02
partner-acme-2026-06-02-00
```

If no generated journals are available, Ledgerise returns:

```json
{
  "status": "error",
  "code": "NO_POSTABLE_JOURNALS",
  "message": "No generated journal entries are ready to post"
}
```

## Create Response

```json
{
  "status": "ok",
  "replayed": false,
  "batch": {
    "id": "b54d860b-1ae7-4c1f-a8a6-0230abc264b7",
    "adapter_name": "generic-journal-csv",
    "status": "posted",
    "journal_entry_count": 1,
    "idempotency_key": "nightly-2026-06-02",
    "created_at": "2026-06-02T01:00:00.000Z",
    "updated_at": "2026-06-02T01:00:00.000Z",
    "artifact": {
      "id": "artifact-id",
      "posting_batch_id": "b54d860b-1ae7-4c1f-a8a6-0230abc264b7",
      "content_type": "text/csv",
      "filename": "ledgerise-journal-b54d860b-1ae7-4c1f-a8a6-0230abc264b7.csv",
      "checksum_sha256": "77ddff56326c236ff0c7941a45b10900afb19b70ca0818b7af6ca92ad3a66bcd",
      "size_bytes": 512,
      "row_count": 3,
      "created_at": "2026-06-02T01:00:00.000Z"
    }
  },
  "posted": [
    {
      "journal_entry_id": "fd46579f-7c3c-4cb0-b822-68a23013845a",
      "external_reference": "csv:b54d860b-1ae7-4c1f-a8a6-0230abc264b7:fd46579f-7c3c-4cb0-b822-68a23013845a"
    }
  ],
  "failed": [],
  "artifact": {
    "content_type": "text/csv",
    "filename": "ledgerise-journal-b54d860b-1ae7-4c1f-a8a6-0230abc264b7.csv",
    "checksum_sha256": "77ddff56326c236ff0c7941a45b10900afb19b70ca0818b7af6ca92ad3a66bcd",
    "content": "batch_id,journal_entry_id,..."
  }
}
```

The top-level `artifact.content` is included for immediate pickup. The same CSV can be downloaded later from the durable artifact endpoint.

## List Batches

```http
GET /api/posting-batches?limit=100&offset=0
Authorization: Bearer <api_key>
```

Response:

```json
{
  "records": [
    {
      "id": "b54d860b-1ae7-4c1f-a8a6-0230abc264b7",
      "adapter_name": "generic-journal-csv",
      "status": "posted",
      "journal_entry_count": 1,
      "artifact": {
        "filename": "ledgerise-journal-b54d860b-1ae7-4c1f-a8a6-0230abc264b7.csv",
        "checksum_sha256": "77ddff56326c236ff0c7941a45b10900afb19b70ca0818b7af6ca92ad3a66bcd"
      }
    }
  ],
  "page": {
    "limit": 100,
    "offset": 0,
    "total": 1
  }
}
```

## Get Batch Detail

```http
GET /api/posting-batches/<batch_id>
Authorization: Bearer <api_key>
```

The response includes batch metadata, included journal entries, and artifact metadata.

## Download CSV Artifact

```http
GET /api/posting-batches/<batch_id>/artifact.csv
Authorization: Bearer <api_key>
```

The response body is the CSV file.

Important response headers:

```http
Content-Type: text/csv
Content-Disposition: attachment; filename="ledgerise-journal-<batch_id>.csv"
x-ledgerise-posting-batch-id: <batch_id>
x-ledgerise-artifact-checksum-sha256: <sha256>
```

Every successful download is recorded in `posting_artifact_downloads`.

## CSV Shape

The generic journal CSV emits one row per journal line.

Columns:

```text
batch_id
journal_entry_id
transaction_id
source_id
generated_at
entry_type
transaction_type
product_line
product_biller
currency
journal_amount
line_order
side
account_code
line_amount
mapping_rule_id
mapping_rule_version
```

Journal entries are currently generated per transaction, not as a daily summary by transaction type.

## Recommended Pull Pattern

1. Schedule the integrator to run at the desired interval.
2. Call `POST /api/posting-batches/generic-journal-csv` with a stable `Idempotency-Key`.
3. Store the returned `batch.id`, `artifact.filename`, and `artifact.checksum_sha256`.
4. Save `artifact.content` immediately, or call `GET /api/posting-batches/<batch_id>/artifact.csv`.
5. If the caller times out, retry the same `POST` with the same idempotency key or fetch the artifact by batch id.
6. Verify the downloaded file checksum against `checksum_sha256`.

Do not retry with a new idempotency key unless you intentionally want a new batch of still-generated journals.
