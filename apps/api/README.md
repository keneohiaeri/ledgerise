# Ledgerise API

Core HTTP API for Ledgerise.

Responsibilities:

- Authentication and authorization
- Canonical transaction ingestion
- Schema validation
- Mapping rule management
- Journal log reads and manual retries
- Adapter registration/configuration
- COA import and reads
- Audit event access

Adapter-specific parsing and posting logic must stay outside the API core.

## Code Structure

```
apps/api/src/
├── index.ts               ← server setup and port binding only (~100 lines)
├── router.ts              ← createRouter(deps) — full dispatch chain over all route modules
├── container.ts           ← repository and service wiring; InMemoryAccessStore; system settings cache
├── lib/
│   ├── http.ts            ← sendJson, readJsonBody, applyCors, getHeader
│   └── crypto.ts          ← encryptConfig, decryptConfig, hashPassword, verifyPassword, signAuthToken, verifyAuthToken
├── middleware/
│   ├── auth.ts            ← requireRole, verifyAuthToken, AuthPrincipal type
│   └── rateLimit.ts       ← checkIngestRateLimit, sliding-window rate limit state
└── routes/
    ├── auth.ts            ← /api/auth/*
    ├── ingestion.ts       ← /api/ingest/*, /api/adapters*, /api/ingestion-errors
    ├── transactions.ts    ← /api/transactions*
    ├── mapping.ts         ← /api/mapping-rules*
    ├── coa.ts             ← /api/coa*
    ├── engine.ts          ← /api/journal-entries*, /api/journal-log*, /api/journals*
    ├── posting.ts         ← /api/posting-batches*, /api/posting-artifacts* (API-key auth)
    ├── adapters.ts        ← /api/api-keys*
    ├── users.ts           ← /api/users*
    └── settings.ts        ← /api/system-settings, /api/audit-log.csv
```

Each route file exports a single `handleXxxRoutes(request, response, url, deps): Promise<boolean>` function. Returning `true` means the route was handled; `false` means the request is passed to the next handler. This makes each module independently testable with an in-memory container — no HTTP server, no database connection required.

### Running Tests

```bash
cd apps/api
npm test
```

Tests use Node's built-in `node:test` runner with `tsx` for TypeScript support. No compiled output needed.

## Posting File Exchange

Outbound CSV exchange endpoints require an API key with scoped access. Pass the key with:

```http
Authorization: Bearer <api_key>
```

or:

```http
x-api-key: <api_key>
```

Supported scopes:

- `posting_batches:create`
- `posting_batches:read`
- `posting_artifacts:download`

Create an idempotent CSV batch:

```http
POST /api/posting-batches/generic-journal-csv
Idempotency-Key: nightly-2026-06-02
Content-Type: application/json
```

```json
{
  "limit": 500
}
```

or export exact journal entries:

```json
{
  "journal_entry_ids": ["<journal_entry_id>"],
  "limit": 1
}
```

Retrieve durable batches and artifacts:

```http
GET /api/posting-batches
GET /api/posting-batches/:id
GET /api/posting-batches/:id/artifact.csv
```

The create endpoint stores the CSV artifact in Postgres, marks included journal entries as posted, and can safely replay the same batch when the same idempotency key is reused.

Post generated journals to Zoho Books:

```http
POST /api/posting-batches/zoho-books
Idempotency-Key: zoho-nightly-2026-06-02
Content-Type: application/json
```

```json
{
  "limit": 100
}
```

Zoho posting uses the same posting batch state machine and returns external references in the form `zoho-books:<journal_id>`.

Required Zoho adapter environment:

- `ZOHO_BOOKS_ORGANIZATION_ID`
- `ZOHO_BOOKS_ACCOUNT_MAP_JSON`
- `ZOHO_BOOKS_ACCESS_TOKEN` or `ZOHO_BOOKS_REFRESH_TOKEN`, `ZOHO_BOOKS_CLIENT_ID`, and `ZOHO_BOOKS_CLIENT_SECRET`

Optional Zoho adapter environment:

- `ZOHO_BOOKS_DC`
- `ZOHO_BOOKS_API_BASE_URL`
- `ZOHO_ACCOUNTS_BASE_URL`
- `ZOHO_BOOKS_AMOUNT_SCALE`
- `ZOHO_BOOKS_JOURNAL_STATUS`
