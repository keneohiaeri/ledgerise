# Zoho Books Adapter

Internal MVP outbound adapter for posting journal entries to Zoho Books.

Zoho-specific OAuth, account IDs, journal payloads, and API errors must stay inside this adapter.

Required contract methods:

- `meta()`
- `validate(input)`
- `postJournals(input)`
- `healthcheck()`

## Configuration

The adapter reads configuration from environment variables:

- `ZOHO_BOOKS_ORGANIZATION_ID`: required Zoho Books organization id.
- `ZOHO_BOOKS_ACCOUNT_MAP_JSON`: required JSON object mapping Ledgerise account codes to Zoho Books account ids.
- `ZOHO_BOOKS_ACCESS_TOKEN`: optional short-lived OAuth access token.
- `ZOHO_BOOKS_REFRESH_TOKEN`, `ZOHO_BOOKS_CLIENT_ID`, `ZOHO_BOOKS_CLIENT_SECRET`: optional refresh-token credentials used when `ZOHO_BOOKS_ACCESS_TOKEN` is not set.
- `ZOHO_BOOKS_DC`: optional Zoho data center code: `com`, `eu`, `in`, `au`, `jp`, `ca`, `cn`, or `sa`.
- `ZOHO_BOOKS_API_BASE_URL`: optional full API base URL override.
- `ZOHO_ACCOUNTS_BASE_URL`: optional OAuth accounts base URL override.
- `ZOHO_BOOKS_AMOUNT_SCALE`: optional minor-unit scale. Defaults to `100`.
- `ZOHO_BOOKS_JOURNAL_STATUS`: `draft` or `published`. Defaults to `draft`.

Example account map:

```json
{
  "1000": "460000000000361",
  "4000": "460000000000362"
}
```

The adapter posts one Zoho journal per Ledgerise journal entry and returns external references in the form:

```text
zoho-books:<journal_id>
```
