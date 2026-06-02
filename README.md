# Ledgerise

**Configurable double-entry automation for payment operators.**

Ledgerise sits between your transaction system and your accounting software, translating settled transactions into accurate double-entry journal entries without manual intervention.

Built for fintech operators in emerging markets who process real transaction volume but lack the engineering resources to build and maintain a custom accounting integration.

---

## The Problem

Your payment system knows everything about every transaction. Your accounting system knows almost nothing. The gap between them is filled by a finance team manually compiling reports, copying numbers across systems, and hoping nothing falls through the cracks.

This does not scale. It also means your financial statements are always behind your operational reality.

Ledgerise closes that gap.

---

## How It Works

```
Source System          Ledgerise                  Accounting System
─────────────          ────────────                  ─────────────────

Paystack         →   Inbound Adapter                       
Flutterwave      →   (normalizes to          →   Journal Engine   →   Zoho Books
M-Pesa           →    canonical schema)      →   (maps to COA)    →   QuickBooks
CSV Upload       →                                                →   Wave
Any System       →                                                →   Any System
```

1. **Inbound adapters** normalize transaction data from any source into a standard internal format
2. **The journal engine** reads the normalized records and applies your mapping rules to produce double-entry journal entries
3. **Outbound adapters** push the journal entries to your accounting system on a schedule

The engine and both adapter layers are independently swappable. Adding a new source system or a new accounting system requires only a new adapter, with no changes to the core.

---

## Features

- **Canonical transaction schema** covering 80 standard transaction types across payments, transfers, collections, fees, lending, savings, FX, cards, agency banking, and system operations
- **Configurable mapping rules** that link product lines, billers, and transaction types to Chart of Accounts entries, managed through a UI without engineering involvement
- **Three-tier mapping fallback** per transaction: exact biller match, then biller category, then product line catch-all
- **Custom transaction types** for operator-specific edge cases, with operator-defined mapping rules
- **Reversal handling** that automatically generates mirror journal entries for reversed transactions
- **Suspense accounts** that park unclassified transactions for manual review rather than dropping or misposting them
- **Journal log and audit trail** with a traceable path from every posted entry back to the source transaction
- **Journal CSV export API** for pulling posting batches into any accounting system that accepts file import
- **Multi-currency support** with ISO 4217 currency codes on every transaction record
- **Test environment protection** that blocks test transactions from reaching the accounting system
- **Role-based access control** with admin and operator roles, user management, and a full audit log
- **AES-256-GCM credential encryption** for all stored adapter credentials
- **Rate limiting** on ingest endpoints with proxy-aware IP detection
- **Structured logging** and a `/healthcheck` endpoint for monitoring

---

## Supported Integrations

### Inbound (transaction sources)

| Adapter | Mode | Status |
|---|---|---|
| Generic Webhook | Webhook | Built |
| Generic CSV | File Import | Built |
| Generic Poll | Poll | Built |

### Outbound (accounting systems)

| Adapter | Status |
|---|---|
| Generic Journal CSV | Built |
| Zoho Books | Built |
| QuickBooks | Roadmap |
| Wave | Roadmap |

Want to add an integration? See [docs/EXTERNAL_ADAPTER_GUIDE.md](docs/EXTERNAL_ADAPTER_GUIDE.md).

---

## Deployment

### Self-Hosted

Ledgerise is open source and can be run entirely on your own infrastructure.

#### Development

```bash
# Clone and install
git clone https://github.com/keneohiaeri/ledgerise.git
cd ledgerise
npm install

# Configure environment
cp .env.example .env
# Edit .env — set DATABASE_URL and bootstrap admin credentials at minimum

# Run database migrations and seed
for f in infra/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
psql "$DATABASE_URL" -f infra/seed/0001_local_operator_and_adapters.sql
psql "$DATABASE_URL" -f infra/seed/0002_default_coa.sql

# Build workspace packages, then start all three services
npm run build
npm run dev
```

`npm run dev` starts the API (port 3000), web dashboard (port 3001), and worker in parallel. On first start, Ledgerise creates a bootstrap admin from the credentials in your `.env` — log in and change the password before anything else.

After editing anything in `core/` or `adapters/`, run `npm run build` again before restarting.

#### Production

Build the project, then run the API and worker as long-lived processes:

```bash
npm run build
npm start          # API on port 3000
npm run start:worker   # worker (separate terminal or process manager)
```

The web frontend (`apps/web/dist/`) is a static build — serve it with nginx or deploy it as a static site on Render/Railway. The API and frontend only need to share a URL: set `VITE_API_BASE_URL` to the public API URL at build time.

For VPS setup (nginx, systemd, TLS), Render, and Railway, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). A `Procfile` is included for platforms that support it.

### Cloud-Hosted

A managed cloud version is available for operators who prefer not to manage infrastructure. The cloud version includes managed adapter hosting, automated updates, uptime monitoring, and multi-tenant isolation.

Join the waitlist: [ledgerise.dev](https://ledgerise.dev)

---

## Configuration

### Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/ledgerise

# Auth
AUTH_TOKEN_SECRET=<generate with: openssl rand -hex 32>

# Credential encryption (required in production)
LEDGERISE_CREDENTIALS_KEY=<generate with: openssl rand -hex 32>

# Bootstrap admin (created on first start)
LEDGERISE_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
LEDGERISE_BOOTSTRAP_ADMIN_PASSWORD=changeme

# Engine
ENGINE_SCHEDULE_CRON=0 * * * *       # How often the journal engine runs
ENGINE_BATCH_SIZE=500                  # Max transactions per engine run
SUSPENSE_ACCOUNT_CODE=9999            # COA code for unclassified transactions
```

### Mapping Rules

Mapping rules are configured through the Ledgerise UI under **Settings > Mapping Rules**. Each rule defines:

- **Product line** — which of your product lines this rule applies to
- **Biller** (optional) — the specific biller or counterparty
- **Biller category** (optional) — used as a fallback when no exact biller match exists
- **Debit account** — the COA account to debit
- **Credit account(s)** — one or more COA accounts to credit, with split percentages if applicable
- **Status** — active or inactive

Rules are evaluated in priority order: exact biller match → biller category → product line catch-all.

---

## Building an Adapter

Ledgerise uses a language-agnostic adapter interface. Any language can implement an adapter provided it fulfills the contract.

Every adapter must implement four methods:

| Method | Description |
|---|---|
| `meta()` | Returns static adapter metadata for registration |
| `validate(input)` | Validates raw input before normalization |
| `normalize(input)` | Converts raw input to canonical transaction records |
| `healthcheck()` | Verifies connectivity to the source system |

- Full interface specification: [docs/ADAPTER_SPEC.md](docs/ADAPTER_SPEC.md)
- Step-by-step contributor guide: [docs/EXTERNAL_ADAPTER_GUIDE.md](docs/EXTERNAL_ADAPTER_GUIDE.md)
- Canonical transaction schema: [schemas/transaction.schema.json](schemas/transaction.schema.json)
- Schema field reference: [docs/SCHEMA_REFERENCE.md](docs/SCHEMA_REFERENCE.md)

To contribute an adapter to the official registry, open a pull request with your adapter in the `/adapters` directory. Your adapter must include unit tests, fixture files, and a README. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## Integrating via Journal CSV

If your accounting system accepts CSV file import, you can pull posting batches from Ledgerise using the Journal CSV API without writing an outbound adapter at all.

See [docs/JOURNAL_CSV_API_GUIDE.md](docs/JOURNAL_CSV_API_GUIDE.md) for the full API reference.

---

## Data Management

For backup, restore, and retention guidance see [docs/DATA_MANAGEMENT.md](docs/DATA_MANAGEMENT.md).

---

## Project Structure

```
ledgerise/
├── apps/
│   ├── web/             # React finance/admin dashboard
│   ├── api/             # Node/TypeScript HTTP API
│   └── worker/          # Scheduled jobs and posting retries
├── core/
│   ├── schema/          # Canonical schema validation
│   ├── ingestion/       # Normalized transaction storage
│   ├── engine/          # Journal generation engine
│   ├── posting/         # Posting queue and retries
│   ├── audit/           # Immutable audit events
│   └── permissions/     # Roles and policies
├── adapters/
│   ├── inbound/         # generic-webhook, generic-csv, generic-poll
│   └── outbound/        # zoho-books, generic-journal-csv
├── packages/
│   ├── adapter-sdk/
│   ├── canonical-types/
│   └── test-fixtures/
├── infra/
│   ├── migrations/
│   └── seed/
├── schemas/
│   └── transaction.schema.json
└── docs/
    ├── ADAPTER_SPEC.md
    ├── SCHEMA_REFERENCE.md
    ├── EXTERNAL_ADAPTER_GUIDE.md
    ├── DEPLOYMENT.md
    ├── DATA_MANAGEMENT.md
    └── JOURNAL_CSV_API_GUIDE.md
```

---

## Roadmap

- [x] Canonical transaction schema (80 transaction types)
- [x] Database ingestion layer
- [x] Generic webhook, CSV, and poll inbound adapters
- [x] Chart of Accounts management with CSV import
- [x] Configurable mapping rules with three-tier fallback
- [x] Journal engine (mapping → double-entry journal entries)
- [x] Journal log, posting queue, and retry handling
- [x] Zoho Books and Generic CSV outbound adapters
- [x] Poll runner with cursor safety
- [x] React dashboard (journal log, COA, mapping rules, adapter config, settings)
- [x] Role-based access control and user management
- [x] AES-256-GCM credential encryption
- [x] Audit log with CSV download
- [x] Production hardening (rate limiting, structured logging, healthcheck)
- [x] Deployment documentation
- [ ] Paystack inbound adapter
- [ ] Flutterwave inbound adapter
- [ ] M-Pesa inbound adapter
- [ ] QuickBooks outbound adapter
- [ ] Wave outbound adapter
- [ ] Xero outbound adapter
- [ ] Formal test suite
- [ ] Multi-tenant cloud version

---

## Contributing

Ledgerise is in active early development. Contributions are welcome, particularly:

- New inbound adapters for payment processors and aggregators
- New outbound adapters for accounting systems
- Bug reports and edge cases from production usage
- Documentation improvements

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

---

## License

Apache 2.0. See [LICENSE](LICENSE) for details.

---

## Acknowledgements

Ledgerise grew out of real operational pain building payment infrastructure in Nigeria. It is designed specifically for operators in emerging markets where transaction volume is real but accounting automation tooling is scarce.
