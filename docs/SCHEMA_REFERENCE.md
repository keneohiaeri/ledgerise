# Ledgerise Canonical Transaction Schema
## Reference Guide v1.0.0

---

## Overview

The canonical transaction schema is the contract between inbound adapters and the journal engine. Every inbound adapter, regardless of source system, must normalize its data into this format before handing it off. The journal engine only speaks this format and has no knowledge of how any specific payment processor structures its data.

This design ensures that the journal engine remains stable and testable independently of any integration, and that new adapters can be added without touching core logic.

---

## Design Principles

**1. Adapter responsibility, not engine responsibility**
Source-specific quirks (inconsistent status codes, split fee fields, non-standard timestamps) are the adapter's problem to resolve. The engine receives clean, normalized data.

**2. Direction by field, not by sign**
Amounts are always positive. The `direction` field (`debit` or `credit`) captures which way money moved from the operator's perspective. This avoids sign convention confusion across currencies and systems.

**3. Amounts in smallest currency unit**
All monetary values (amount, fees, float balances) are integers in the smallest unit of the currency. NGN uses kobo, USD uses cents, KES uses cents. This eliminates floating-point rounding errors in journal arithmetic.

**4. Currency on every record**
Every transaction carries an ISO 4217 currency code. There is no concept of a "base currency" baked into the schema. The accounting system adapter handles any currency conversion requirements at the output layer.

**5. Product context drives mapping**
The journal engine resolves which COA accounts to debit and credit using `product.line`, `product.biller`, and `product.biller_category` in that priority order. Adapters must populate these fields accurately.

**6. Metadata is a safety valve**
The `metadata` object carries anything that does not fit the canonical schema. It is stored for auditability but the engine does not read it for mapping decisions. Adapters should not use metadata as a substitute for properly mapping fields.

---

## Field Reference

### Top-Level Identity

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | UUID string | Yes | Ledgerise-generated record ID. Not the source system ID. |
| `source_id` | string | No | Original ID from the source system. Used for deduplication. |

### Source Object

Identifies where the transaction came from. Used for deduplication guards and audit trail.

| Field | Type | Required | Description |
|---|---|---|---|
| `source.adapter` | string | Yes | Kebab-case name of the inbound adapter. e.g. `paystack-webhook` |
| `source.system` | string | Yes | The upstream platform. e.g. `paystack`, `interswitch` |
| `source.environment` | string | No | `live` or `test`. Defaults to `live`. Test transactions are blocked from posting. |

### Timestamps

All timestamps must be ISO 8601 with timezone offset or `Z` for UTC.

| Field | Type | Required | Description |
|---|---|---|---|
| `occurred_at` | datetime | Yes | When the transaction happened in the source system. Used as the journal entry date. |
| `settled_at` | datetime or null | Yes | When the transaction was finalized. Null means still pending. |
| `processed_at` | datetime or null | No | When Ledgerise normalized this record. |

### Status

| Value | Description |
|---|---|
| `pending` | Transaction is in flight. Not eligible for posting. |
| `settled` | Transaction is final. Eligible for journal posting. |
| `failed` | Transaction did not complete. Not posted. |
| `reversed` | Transaction was reversed after settlement. Engine generates a reversal entry if the original was already posted. |
| `disputed` | Transaction is under dispute. Held from posting until resolved. |

### Transaction Type

The `type` field uses dot notation: `category.subcategory` or `category.subcategory.detail`. The schema accepts values in two ways:

**Standard types (80 values across 10 categories):** `payment`, `transfer`, `collection`, `fee`, `loan`, `savings`, `investment`, `remittance`, `fx`, `card`, `agency`, and `system`. These work out of the box with no additional configuration.

**Custom operator-defined types:** Allowed when no standard type fits the operator's use case. Must follow the same dot notation pattern. Two things are required for a custom type to work:

1. The adapter emits the custom type string on matching transactions
2. A corresponding mapping rule exists in the operator's mapping configuration

If either condition is missing, the engine flags the transaction as `unmapped` and holds it for manual review. It will never guess or silently drop it.

The engine uses `type` in combination with `product` fields to resolve mapping rules. When an exact `biller` match exists in the mapping configuration, `type` is secondary. When no biller match exists, `type` and `biller_category` are the fallback.

### Amounts and Fees

All values in the smallest currency unit (integer).

| Field | Type | Description |
|---|---|---|
| `amount` | positive number | The face value of the transaction. Always positive. |
| `fee.platform_fee` | positive number | Fee charged to the customer. Operator revenue. |
| `fee.processing_fee` | positive number | Fee charged by aggregator to operator. Operator cost. |
| `fee.net_fee` | number | `platform_fee - processing_fee`. Operator margin. |

### Principal Object

The customer, merchant, or agent on the transaction. The `id` must be a stable internal identifier that does not contain raw PII. Phone numbers, BVN, or card numbers must never appear in `principal.id`.

### Product Object

This is the most important object for the journal engine.

| Field | Priority | Description |
|---|---|---|
| `product.line` | 1 | The operator's product line. Always required. |
| `product.biller` | 2 | Exact biller identifier. Engine tries this first for mapping. |
| `product.biller_category` | 3 | Biller category. Used as fallback when no exact biller rule exists. |

Mapping rule resolution order:
1. Match on `product.line` + `product.biller`
2. Match on `product.line` + `product.biller_category`
3. Match on `product.line` only (catch-all rule for that product line)
4. No match: transaction is flagged as `unmapped` and held for manual review

### Float Object

Used when the operator holds pre-funded float with an aggregator. When populated, the engine maps the debit side of a transaction to the correct aggregator float asset account rather than a generic cash account.

### Reversal Handling

When `status` is `reversed` and `reversal_of` contains the `id` of the original transaction, the engine checks whether the original was posted. If it was, it generates a mirror reversal entry with debits and credits swapped and the `occurred_at` of the reversal record as the posting date.

---

## Adapter Contract

Every inbound adapter must:

1. Accept source data in any format (webhook payload, CSV row, API response)
2. Validate required fields are present and non-null before emitting
3. Generate a UUID for `id`
4. Set `processed_at` to the normalization timestamp
5. Default `source.environment` to `live` unless the source data explicitly indicates test mode
6. Emit amounts in the smallest currency unit
7. Emit a valid ISO 4217 `currency` code
8. Never pass raw PII into `principal.id` or `principal.reference`
9. Mask sensitive values in `principal.reference` before emitting
10. Emit only valid `status` enum values. Map source-specific statuses at the adapter layer.

---

## Versioning

The schema version is carried in the `$id` URI: `https://ledgerise.dev/schemas/transaction/v1.json`.

Breaking changes (field removals, type changes, enum changes) increment the major version. Additive changes (new optional fields) increment the minor version. Adapters must declare which schema version they emit. The engine rejects records whose schema version it does not support.

---

## Example Record

See `transaction.schema.json` for a full annotated example using a Nigerian electricity bill payment through the AirVend consumer app via the BuyPower aggregator float.
