# Ledgerise Adapter Interface Specification
## v1.0.0

---

## 1. What an Adapter Is

An adapter is a self-contained module that knows how to speak to one source system and how to translate that system's transaction data into the Ledgerise canonical transaction schema.

The engine knows nothing about Paystack, Flutterwave, M-Pesa, or any other system. Adapters are the only thing that does. This boundary is intentional and must be maintained. An adapter must never contain journal logic. The engine must never contain source-specific parsing logic.

---

## 2. Adapter Modes

Every adapter must declare which modes it supports. A given adapter may support one or more.

### 2.1 Webhook Mode
The source system pushes individual transaction events to a URL the adapter exposes. The adapter receives the raw payload, normalizes it, and emits a single canonical transaction record.

### 2.2 Poll Mode
The adapter is invoked on a schedule (e.g. every 5 minutes, every hour) and calls the source system's API to fetch a batch of transactions since the last successful poll. It normalizes each record and emits a list of canonical transaction records.

### 2.3 File Import Mode
The adapter accepts a flat file (CSV, XLSX, JSON) uploaded by the operator. It parses each row or record, normalizes it, and emits a list of canonical transaction records.

### 2.4 Manual Entry Mode
The adapter accepts a structured form submission from the Ledgerise UI for a single transaction entered directly by an operator. It normalizes and emits one canonical transaction record. This mode is for edge cases only and must not be used as a substitute for automation.

---

## 3. The Adapter Contract

Every adapter, regardless of mode or source system, must fulfill this contract completely.

### 3.1 Inputs

The adapter receives one of the following depending on its mode:

| Mode | Input |
|---|---|
| Webhook | Raw HTTP request body (JSON, form-encoded, or XML) + request headers |
| Poll | Cursor object: `{ last_fetched_at: ISO8601, last_source_id: string }` |
| File Import | File buffer + file metadata: `{ filename, mimetype, size }` |
| Manual Entry | Structured form object matching operator-defined fields |

### 3.2 Outputs

Every adapter method must return one of two things:

**Success:**
```
{
  status: "ok",
  records: [ ...canonical transaction records ],
  cursor: { ... }   // Poll mode only. Marks progress for next run.
}
```

**Failure:**
```
{
  status: "error",
  code: string,       // Machine-readable error code. See Section 6.
  message: string,    // Human-readable description.
  raw: any            // The original input that caused the failure. For debugging.
}
```

The adapter must never throw an unhandled exception. All errors must be caught and returned in the failure envelope above.

### 3.3 Required Methods

Every adapter must implement these four methods. Methods not applicable to the adapter's supported modes must still be present but should return a `METHOD_NOT_SUPPORTED` error.

---

**`adapter.meta()`**

Returns static metadata describing the adapter. Called by Ledgerise at registration time.

Returns:
```json
{
  "name": "paystack-webhook",
  "version": "1.0.0",
  "author": "Your Name or Org",
  "source_system": "paystack",
  "modes": ["webhook"],
  "currency_codes": ["NGN"],
  "docs_url": "https://your-repo/adapters/paystack-webhook/README.md"
}
```

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique kebab-case adapter identifier. Must be unique across all registered adapters. |
| `version` | Yes | Semantic version string. |
| `author` | Yes | Name or GitHub handle of the adapter author. |
| `source_system` | Yes | The upstream platform this adapter reads from. |
| `modes` | Yes | Array of supported modes. At least one required. |
| `currency_codes` | Yes | ISO 4217 codes this adapter can produce. |
| `docs_url` | Yes | Link to the adapter's own README. |

---

**`adapter.validate(input)`**

Validates raw input before normalization. Returns a list of validation errors if the input is malformed, or an empty list if the input is clean.

This method must be called internally by `adapter.normalize()` before any normalization logic runs. It is also exposed publicly so the engine can surface validation errors to operators without triggering normalization.

Returns:
```json
{
  "valid": true,
  "errors": []
}
```

Or on failure:
```json
{
  "valid": false,
  "errors": [
    {
      "field": "amount",
      "message": "Amount is missing or zero",
      "raw_value": null
    }
  ]
}
```

---

**`adapter.normalize(input)`**

The core method. Accepts raw input, validates it, and returns a success or failure envelope.

On success, `records` contains one or more canonical transaction records conforming to `transaction.schema.json v1.0.0`.

Rules the adapter must follow inside this method:

1. Call `adapter.validate(input)` first. If validation fails, return a failure envelope immediately.
2. Generate a new UUID v4 for every record's `id` field.
3. Set `processed_at` to the current UTC timestamp.
4. Set `source.adapter` to the adapter's own `name` from `meta()`.
5. Convert all monetary amounts to the smallest currency unit before emitting.
6. Mask any sensitive values in `principal.reference` before emitting. Phone numbers must show no more than the last 4 digits. Card numbers must show no more than the last 4 digits. BVN and NIN must never appear.
7. Never emit a record where `source.environment` is `test` without explicitly setting it to `"test"`. Default to `"live"` only when the source data confirms the transaction is real.
8. For failed transactions: normalize and emit them with `status: "failed"` set. Do not filter them out. Add a `_adapter_flag` key to the record's `metadata` object with the value `"failed-passthrough"` so the engine can identify adapter-flagged records.
9. Do not set any COA account codes on the record. Account mapping is the engine's responsibility, not the adapter's.
10. Do not modify the canonical schema structure. Do not add top-level fields outside the schema. Extra fields belong in `metadata`.

---

**`adapter.healthcheck()`**

Verifies that the adapter can reach its source system. For webhook adapters, this may simply return `ok` since the source pushes to them. For poll adapters, this must attempt a lightweight API call (e.g. fetching account info or a single record) and confirm a successful response.

Returns:
```json
{
  "status": "ok",
  "latency_ms": 142,
  "checked_at": "2026-05-30T08:00:00Z"
}
```

Or on failure:
```json
{
  "status": "error",
  "code": "SOURCE_UNREACHABLE",
  "message": "Paystack API returned 503",
  "checked_at": "2026-05-30T08:00:00Z"
}
```

---

## 4. Configuration

Adapters must not hardcode credentials, API keys, base URLs, or operator-specific settings. All configuration must be injected at runtime through a config object passed to the adapter at initialization.

Each adapter must document its required and optional config keys in its own README. Example:

```json
{
  "PAYSTACK_SECRET_KEY": "sk_live_...",
  "PAYSTACK_WEBHOOK_SECRET": "whsec_...",
  "POLL_INTERVAL_SECONDS": 300,
  "PRODUCT_LINE": "consumer-app"
}
```

Config keys must be in `SCREAMING_SNAKE_CASE`. Sensitive keys (secrets, API keys) must never be logged by the adapter under any circumstances.

---

## 5. Deduplication

Adapters are stateless with respect to deduplication. They forward every record they normalize, including potential duplicates. The engine is responsible for deduplication using the `source_id` field.

Adapters must populate `source_id` with the most stable unique identifier available from the source system. If the source system provides no stable ID, the adapter must document this limitation clearly in its README and set `source_id` to null.

---

## 6. Error Codes

Adapters must use these standard error codes in failure envelopes. Custom codes are permitted using the `ADAPTER_` prefix.

| Code | Description |
|---|---|
| `VALIDATION_FAILED` | Input failed schema validation. See `errors` array. |
| `SOURCE_UNREACHABLE` | Could not connect to the source system. |
| `AUTH_FAILED` | Credentials rejected by the source system. |
| `RATE_LIMITED` | Source system returned a rate limit response. |
| `MALFORMED_PAYLOAD` | Input could not be parsed at all (e.g. invalid JSON). |
| `UNSUPPORTED_EVENT` | The event type from the source system is not mapped. |
| `METHOD_NOT_SUPPORTED` | The called method is not supported by this adapter's modes. |
| `ADAPTER_*` | Custom adapter-specific error. Must be documented in the adapter README. |

---

## 7. Naming Convention

Adapter names must follow this pattern: `{source-system}-{mode}`

Examples:
- `paystack-webhook`
- `flutterwave-webhook`
- `mpesa-poll`
- `vtpass-csv`
- `interswitch-webhook`

If an adapter supports multiple modes, create separate named adapters per mode rather than one adapter that handles all modes. This keeps each adapter simple and independently testable.

---

## 8. Testing Requirements

Every adapter submitted to the Ledgerise registry must include:

1. **Unit tests** covering `validate()` and `normalize()` with at least:
   - One valid settled transaction
   - One failed transaction (confirms `status: "failed"` and `_adapter_flag` in metadata)
   - One transaction with missing required fields (confirms validation failure envelope)
   - One transaction from a test environment (confirms `source.environment: "test"`)

2. **Fixture files** containing real or realistic anonymized payloads from the source system, stored in a `/fixtures` directory in the adapter folder.

3. **A README** documenting:
   - Supported modes
   - Required and optional config keys
   - Any known limitations or edge cases
   - The `source_id` strategy used
   - Any custom type values the adapter emits and why

---

## 9. Adapter Registration

To register an adapter with the Ledgerise engine:

1. Place the adapter in the `/adapters` directory following the naming convention
2. The engine calls `adapter.meta()` at startup to register it
3. The engine calls `adapter.healthcheck()` before the first run
4. Operators configure which adapters are active and supply config values through the Ledgerise settings UI or config file

An adapter that fails `healthcheck()` is marked inactive. The engine logs the failure and retries on the next cycle. It does not crash.

---

## 10. What Adapters Must Never Do

- Contain journal mapping logic or COA account references
- Write directly to the accounting system
- Modify a canonical record after it has been emitted
- Log raw credentials or secrets
- Swallow errors silently
- Emit records that do not conform to `transaction.schema.json v1.0.0`
- Add top-level fields to the canonical record outside the schema
- Assume a default currency without explicit source data confirming it
