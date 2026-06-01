# Infra

Keep infrastructure simple for the first implementation pass.

## Database

Primary target: PostgreSQL.

MySQL can be supported later through the same repository boundary if the data-access layer avoids PostgreSQL-only assumptions where practical.

Local setup can use a database installed directly on your machine.

Example PostgreSQL URL:

```env
DATABASE_CLIENT=postgres
DATABASE_URL=postgresql://ledgerise:ledgerise@localhost:5432/ledgerise
```

Example MySQL URL:

```env
DATABASE_CLIENT=mysql
DATABASE_URL=mysql://ledgerise:ledgerise@localhost:3306/ledgerise
```

## Migrations

Migration files live in `infra/migrations/`.

The current files are plain SQL reference migrations for PostgreSQL. A migration runner can be selected later without changing the SQL contract.

Apply the current migration manually with `psql`:

```bash
psql "$DATABASE_URL" -f infra/migrations/0001_core_ingestion.sql
psql "$DATABASE_URL" -f infra/migrations/0002_mapping_rules_and_coa.sql
```

## Seed Data

Seed scripts and sample data live in `infra/seed/`.

`0001_local_operator_and_adapters.sql` creates a local operator and registers the default MVP adapters.

Apply the current seed manually with `psql`:

```bash
psql "$DATABASE_URL" -f infra/seed/0001_local_operator_and_adapters.sql
psql "$DATABASE_URL" -f infra/seed/0002_default_coa.sql
```

When `DATABASE_URL` is set, `apps/api` uses PostgreSQL for ingestion storage. It resolves the default operator in this order:

1. `DEFAULT_OPERATOR_ID`
2. `DEFAULT_OPERATOR_SLUG`
3. `local-operator`

Without `DATABASE_URL`, the API uses the in-memory repository for local scaffold checks.

After applying the migration and seed, verify ingestion behavior against PostgreSQL:

```bash
npm run build
DATABASE_URL="$DATABASE_URL" npm run verify:postgres
DATABASE_URL="$DATABASE_URL" npm run verify:mapping
```

This starts the built API on a temporary port and verifies valid ingestion, duplicate handling, invalid ingestion errors, transaction list/detail reads, and ingestion error reads.

## Ingestion List Query Parameters

`GET /api/transactions` supports:

- `limit`
- `offset`
- `status`
- `posting_status`
- `product_line`
- `biller`
- `adapter`
- `environment`
- `occurred_from`
- `occurred_to`

`GET /api/ingestion-errors` supports:

- `limit`
- `offset`
- `adapter`
- `error_type`
- `source_system`
- `source_id`
- `occurred_from`
- `occurred_to`
