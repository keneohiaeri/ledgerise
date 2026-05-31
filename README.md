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
CSV Upload       →                                                 →   Wave
Any System       →                                                 →   Any System
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
- **Multi-currency support** with ISO 4217 currency codes on every transaction record
- **Test environment protection** that blocks test transactions from reaching the accounting system

---

## Supported Integrations

### Inbound (transaction sources)
| Adapter | Mode | Status |
|---|---|---|
| Paystack | Webhook | Planned |
| Flutterwave | Webhook | Planned |
| Interswitch | Webhook | Planned |
| M-Pesa (Daraja) | Poll | Planned |
| Generic CSV | File Import | Planned |
| Generic Webhook | Webhook | Planned |

### Outbound (accounting systems)
| Adapter | Status |
|---|---|
| Zoho Books | Planned |
| QuickBooks | Roadmap |
| Wave | Roadmap |

Want to add an integration? See [Building an Adapter](#building-an-adapter).

---

## Deployment

### Self-Hosted

Ledgerise is open source and can be run entirely on your own infrastructure.

```bash
# Clone the repository
git clone https://github.com/your-org/ledgerise.git
cd ledgerise

# Copy and configure environment variables
cp .env.example .env

# Install dependencies
npm install

# Start the web, API, and worker workspaces
npm run dev
```

Ledgerise targets Node.js, TypeScript, React, and a relational database. PostgreSQL is the primary database target for the first implementation pass; MySQL support can be added behind the same data-access boundary later.

### Cloud-Hosted

A managed cloud version of Ledgerise is available for operators who prefer not to manage infrastructure. The cloud version includes:

- Managed adapter hosting and scheduling
- Automated schema and engine updates
- Uptime monitoring and alerting
- Multi-tenant operator isolation

Join the waitlist: [ledgerise.dev](https://ledgerise.dev)

---

## Configuration

Ledgerise is configured through a combination of environment variables (infrastructure settings) and the mapping configuration UI (business rules).

### Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/ledgerise

# Engine
ENGINE_SCHEDULE_CRON=0 * * * *       # How often the journal engine runs
ENGINE_BATCH_SIZE=500                  # Max transactions per engine run
SUSPENSE_ACCOUNT_CODE=9999            # COA code for unclassified transactions

# Accounting system (outbound adapter)
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_ORGANIZATION_ID=...
```

### Mapping Rules

Mapping rules are configured through the Ledgerise UI under **Settings > Mapping Rules**. Each rule defines:

- **Product line** - which of your product lines this rule applies to
- **Biller** (optional) - the specific biller or counterparty
- **Biller category** (optional) - used as a fallback when no exact biller match exists
- **Debit account** - the COA account to debit
- **Credit account(s)** - one or more COA accounts to credit, with split percentages if applicable
- **Status** - active or inactive

Rules are evaluated in priority order: exact biller match, then biller category, then product line catch-all.

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

Full specification: [ADAPTER_SPEC.md](ADAPTER_SPEC.md)

Canonical transaction schema: [transaction.schema.json](schemas/transaction.schema.json)

Schema field reference: [SCHEMA_REFERENCE.md](docs/SCHEMA_REFERENCE.md)

To contribute an adapter to the official registry, open a pull request with your adapter in the `/adapters` directory. Your adapter must include unit tests, fixture files, and a README. See the [contribution guide](CONTRIBUTING.md) for details.

---

## Project Structure

```
ledgerise/
├── apps/
│   ├── web/             # React finance/admin UI
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
├── docs/
│   └── SCHEMA_REFERENCE.md
├── ADAPTER_SPEC.md
├── CONTRIBUTING.md
└── README.md
```

---

## Roadmap

- [ ] Zoho Books outbound adapter
- [ ] Paystack inbound adapter
- [ ] Flutterwave inbound adapter
- [ ] Generic webhook inbound adapter
- [ ] Generic CSV inbound adapter
- [ ] Mapping rules UI
- [ ] Journal log and audit dashboard
- [ ] QuickBooks outbound adapter
- [ ] M-Pesa inbound adapter
- [ ] Multi-tenant cloud version
- [ ] Wave outbound adapter
- [ ] Xero outbound adapter

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
