# Contributing to Ledgerise

First, thank you for taking the time to contribute. Ledgerise is built on the idea that the fintech accounting automation problem is best solved in the open, by people who have actually lived it. Every contribution, whether it is a new adapter, a bug fix, a documentation improvement, or a question that exposes a gap in our thinking, moves that forward.

This guide covers everything you need to know before opening an issue or pull request.

---

## Table of Contents

1. [Code of Conduct](#1-code-of-conduct)
2. [What We Are Building](#2-what-we-are-building)
3. [Ways to Contribute](#3-ways-to-contribute)
4. [Before You Start](#4-before-you-start)
5. [Development Setup](#5-development-setup)
6. [Project Structure](#6-project-structure)
7. [Contributing an Adapter](#7-contributing-an-adapter)
8. [Contributing to the Core Engine](#8-contributing-to-the-core-engine)
9. [Contributing to the UI](#9-contributing-to-the-ui)
10. [Contributing Documentation](#10-contributing-documentation)
11. [Submitting a Pull Request](#11-submitting-a-pull-request)
12. [Issue Guidelines](#12-issue-guidelines)
13. [Commit Message Convention](#13-commit-message-convention)
14. [Code Style](#14-code-style)
15. [Testing Requirements](#15-testing-requirements)
16. [Versioning](#16-versioning)
17. [Getting Help](#17-getting-help)

---

## 1. Code of Conduct

Ledgerise is a welcoming project. We expect all contributors to engage respectfully, give constructive feedback, and assume good intent from others. Harassment, discrimination, and dismissiveness have no place here.

If you experience or witness behaviour that violates these principles, please open a private issue or contact the maintainers directly.

---

## 2. What We Are Building

Ledgerise is a configurable automation layer that translates settled payment transactions into double-entry journal entries and posts them to an accounting system. It is designed for fintech operators in emerging markets who process real transaction volume but lack the tooling to keep their books current automatically.

Before contributing, please read:

- [README.md](README.md) for the project overview
- [ADAPTER_SPEC.md](docs/ADAPTER_SPEC.md) for the adapter interface contract
- [docs/SCHEMA_REFERENCE.md](docs/SCHEMA_REFERENCE.md) for the canonical transaction schema

Understanding these three documents will give you the context you need for almost any contribution.

---

## 3. Ways to Contribute

**Build an inbound adapter**
Write a new adapter for a payment processor, aggregator, or transaction source not yet supported. This is the highest-impact contribution you can make. See [Contributing an Adapter](#7-contributing-an-adapter).

**Build an outbound adapter**
Write a new adapter for an accounting system. Zoho Books ships at launch. QuickBooks, Wave, Xero, and Sage are on the roadmap and open for contribution.

**Report a bug**
Found something that does not work as documented? Open an issue using the bug report template.

**Suggest an improvement**
Have an idea for a new feature or a change to existing behaviour? Open a discussion issue before writing any code. This avoids wasted effort if the direction does not fit the project's goals.

**Improve documentation**
Unclear explanations, missing examples, typos, or outdated content are all valid contributions. Documentation improvements are always welcome.

**Add transaction types to the taxonomy**
If you work with a fintech product type not covered by the current 80 standard transaction types, open an issue proposing new types with a description of the use case. See [docs/SCHEMA_REFERENCE.md](docs/SCHEMA_REFERENCE.md) for the current taxonomy.

**Review pull requests**
Reading and commenting on open pull requests is a valuable contribution that does not require writing code.

---

## 4. Before You Start

**Check existing issues and pull requests first.** Someone may already be working on what you have in mind. A quick search can save you from duplicating effort.

**Open an issue before writing significant code.** For anything beyond a small bug fix or documentation change, open an issue first to describe what you plan to build and why. This lets maintainers give early feedback and confirm the contribution fits the project's direction before you invest time in it.

**For adapter contributions, check the adapter registry.** The [adapters](adapters/) directory contains the current list of supported adapters. If your target system is not there, it is open for contribution.

---

## 5. Development Setup

### Prerequisites

- Node.js 20 or higher
- PostgreSQL installed locally for the first implementation pass
- Git

### Clone and install

```bash
git clone https://github.com/[yourhandle]/ledgerise.git
cd ledgerise
npm install
```

### Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your local configuration. The `.env.example` file documents every available variable.

Add bootstrap admin credentials so the API creates your first user on startup:

```env
LEDGERISE_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
LEDGERISE_BOOTSTRAP_ADMIN_PASSWORD=changeme
```

These only need to be set once. After first login and password change the user is persisted in the database and these lines can be removed.

### Run database migrations

```bash
for f in infra/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
psql "$DATABASE_URL" -f infra/seed/0001_local_operator_and_adapters.sql
psql "$DATABASE_URL" -f infra/seed/0002_default_coa.sql
```

All migration files are idempotent — safe to re-run.

### Run the development server

```bash
npm run dev
```

This starts the API (port 3000), web dashboard (port 3001), and worker in parallel. The API dev script loads `.env` automatically — no extra env setup needed.

**Postgres vs memory mode.** If `DATABASE_URL` is absent the API falls back to an in-memory repository — all data is lost on restart and login will fail. The health endpoint reveals which mode is active:

```
GET /api/health
{"repository":"postgres","db":"ok"}   ← connected to database
{"repository":"memory"}               ← no DATABASE_URL, in-memory only
```

### After changing core packages

`tsx watch` hot-reloads `apps/api/src/index.ts` but does **not** recompile workspace packages in `core/` or `adapters/`. After editing anything there, stop the dev server, rebuild, then restart:

```bash
npm run build
npm run dev
```

### Run tests

```bash
npm test
```

### Run tests for a specific adapter

```bash
npm test -- --filter adapters/inbound/generic-webhook
```

---

## 6. Project Structure

```
ledgerise/
├── apps/
│   ├── web/             # React frontend
│   ├── api/             # Node/TypeScript HTTP API
│   └── worker/          # Scheduled jobs
├── core/
│   ├── schema/          # Canonical schema validator
│   ├── ingestion/       # Transaction ingestion
│   ├── engine/          # Journal generation engine
│   ├── posting/         # Posting queue and retries
│   ├── audit/           # Audit log
│   └── permissions/     # Roles and access policies
├── adapters/
│   ├── inbound/         # Source system adapters
│   │   └── [adapter-name]/
│   │       ├── adapter.json
│   │       ├── src/
│   │       ├── fixtures/
│   │       ├── tests/
│   │       └── README.md
│   └── outbound/        # Accounting system adapters
│       └── [adapter-name]/
│           ├── adapter.json
│           ├── src/
│           ├── fixtures/
│           ├── tests/
│           └── README.md
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
│   ├── ADAPTER_SPEC.md
│   └── SCHEMA_REFERENCE.md
├── CONTRIBUTING.md
└── README.md
```

Each adapter lives in its own directory under `adapters/inbound/` or `adapters/outbound/`. The directory name is the adapter name and must follow the naming convention described in Section 7.

---

## 7. Contributing an Adapter

Adapters are the most common and most valuable type of contribution. This section covers everything you need to build one correctly.

### 7.1 Read the adapter spec first

The [ADAPTER_SPEC.md](docs/ADAPTER_SPEC.md) is the authoritative reference for what every adapter must implement. Read it completely before writing any code. The spec defines the four required methods, the output envelope format, the normalize method rules, and the testing requirements.

### 7.2 Naming convention

Adapter directory names follow this pattern: `{source-system}-{mode}`

Examples:
- `generic-webhook`
- `generic-csv`
- `generic-poll`
- `zoho-books`
- `generic-journal-csv`

One adapter per mode. If a source system supports both webhook and poll, create two separate adapters.

### 7.3 Directory structure

Every adapter must follow this structure:

```
adapters/inbound/your-adapter-name/
├── index.ts          # Adapter implementation
├── types.ts          # Source system type definitions (optional)
├── fixtures/
│   ├── settled.json          # A valid settled transaction payload
│   ├── failed.json           # A failed transaction payload
│   ├── test-environment.json # A test/sandbox transaction payload
│   └── missing-fields.json   # A payload with missing required fields
├── tests/
│   └── your-adapter-name.test.ts
└── README.md
```

### 7.4 The four required methods

Your adapter must implement `meta()`, `validate()`, `normalize()`, and `healthcheck()`. See [ADAPTER_SPEC.md](docs/ADAPTER_SPEC.md) Section 3.3 for the full contract for each method.

A minimal adapter skeleton:

```typescript
import { AdapterMeta, AdapterResult, CanonicalTransaction } from '../../types';

export const meta = (): AdapterMeta => ({
  name: 'your-adapter-name',
  version: '1.0.0',
  author: 'Your Name',
  source_system: 'source-system-name',
  modes: ['webhook'],
  currency_codes: ['NGN'],
  docs_url: 'https://github.com/[yourhandle]/ledgerise/tree/main/adapters/inbound/your-adapter-name'
});

export const validate = (input: unknown): { valid: boolean; errors: ValidationError[] } => {
  // Validate the raw input from the source system
  // Return errors array if invalid, empty array if valid
};

export const normalize = async (input: unknown): Promise<AdapterResult> => {
  const validation = validate(input);
  if (!validation.valid) {
    return {
      status: 'error',
      code: 'VALIDATION_FAILED',
      message: 'Input failed validation',
      raw: input
    };
  }

  // Transform source data into canonical transaction record(s)
  // Return success envelope with records array
};

export const healthcheck = async (): Promise<HealthcheckResult> => {
  // Verify connectivity to the source system
  // Webhook adapters may return ok without an outbound call
};
```

### 7.5 Normalize method rules

These rules are non-negotiable. An adapter that violates any of them will not be merged:

1. Always call `validate()` first inside `normalize()`. Return a failure envelope immediately on validation failure.
2. Generate a new UUID v4 for every record's `id` field. Never copy the source system's ID into the `id` field. Use `source_id` for that.
3. Set `processed_at` to the current UTC timestamp at normalization time.
4. Set `source.adapter` to the adapter's own name from `meta()`.
5. Convert all monetary amounts to the smallest currency unit. NGN to kobo, USD to cents, KES to cents.
6. Mask sensitive values in `principal.reference`. Phone numbers: last 4 digits only. Card numbers: last 4 digits only. BVN and NIN must never appear anywhere in the record.
7. Default `source.environment` to `live` only when the source data explicitly confirms it. Never assume.
8. For failed transactions: emit them with `status: "failed"` and add `_adapter_flag: "failed-passthrough"` to the `metadata` object.
9. Never set COA account codes on any field. Account mapping is the engine's responsibility.
10. Never add top-level fields outside the canonical schema. Extra data belongs in `metadata`.

### 7.6 Fixture files

Fixture files are real or realistic anonymized payloads from the source system. They serve two purposes: they document what the source system actually sends, and they are the input data for your tests.

All sensitive data in fixture files must be anonymized. Use obviously fake values (e.g. `"phone": "080****0000"`, `"amount": 100000`). Never commit real transaction data, real customer identifiers, or real API credentials.

### 7.7 Adapter README

Every adapter must include a README.md covering:

- What source system the adapter connects to and which mode it uses
- All required and optional config keys with descriptions
- The `source_id` strategy: which field from the source system is used and why
- Any known limitations or edge cases
- Any custom transaction type values the adapter emits and the justification
- A link to the source system's API documentation

### 7.8 Testing requirements

Every adapter must include tests covering at minimum:

| Test case | What it verifies |
|---|---|
| Valid settled transaction | `normalize()` returns a valid canonical record with `status: settled` |
| Failed transaction | `normalize()` returns a record with `status: failed` and `_adapter_flag: "failed-passthrough"` in metadata |
| Missing required fields | `normalize()` returns a failure envelope, not a thrown exception |
| Test environment transaction | `normalize()` returns a record with `source.environment: "test"` |
| Sensitive field masking | `principal.reference` is masked in the output |
| Amount conversion | Amount is correctly converted to the smallest currency unit |

Tests must not make real network calls. Mock all external API calls. Fixture files are the source of test input data.

---

## 8. Contributing to the Core Engine

The journal engine is the most sensitive part of the codebase. Changes here affect correctness of financial records. The bar for engine contributions is higher than for adapters.

### Rules for engine contributions

- Every engine change must include tests that cover the affected code path
- Double-entry validation must never be weakened. Every journal entry must balance.
- The suspense account fallback must never be removed or bypassed
- Test environment isolation must never be weakened
- Deduplication logic must never be relaxed

### What requires a discussion issue first

Any of the following require an open discussion issue with maintainer agreement before a pull request will be considered:

- Changes to the mapping rule resolution order
- Changes to the retry policy
- Changes to how reversals are handled
- Any change to the canonical schema (see below)

### Proposing canonical schema changes

The canonical transaction schema is a versioned contract. Changes affect every adapter and every integration. Schema changes follow this process:

1. Open an issue describing the proposed change, the use case it enables, and the migration path for existing adapters
2. Maintainers and community members discuss the proposal
3. If approved, a schema version bump is planned alongside adapter migration guidance
4. Breaking changes increment the major version. Additive changes increment the minor version.

Do not submit a pull request that modifies `transaction.schema.json` without a prior approved discussion issue.

---

## 9. Contributing to the UI

The Ledgerise UI is built in React with TypeScript. UI contributions follow the same pull request process as code contributions.

For significant UI changes, include screenshots or a short screen recording in your pull request description. This makes review much faster.

Component-level changes do not require a discussion issue first. New pages or significant changes to existing pages do.

---

## 10. Contributing Documentation

Documentation contributions are always welcome and do not require a discussion issue.

When editing documentation:

- Write in plain, direct English. Avoid jargon where plain language works equally well.
- Use present tense. "The engine processes" not "The engine will process."
- Use active voice. "The adapter emits a record" not "A record is emitted by the adapter."
- Code examples must be accurate and tested. Do not include code you have not verified works.
- If you are documenting a behaviour that does not yet exist in code, mark it clearly as planned or roadmap.

---

## 11. Submitting a Pull Request

### Before you submit

- [ ] Your branch is up to date with `main`
- [ ] All tests pass locally (`npm test`)
- [ ] You have added tests for new behaviour
- [ ] You have updated documentation affected by your change
- [ ] Adapter contributions include fixture files and a README
- [ ] No real credentials, API keys, or PII appear anywhere in the diff

### Pull request title

Use the format: `type(scope): short description`

Examples:
- `feat(adapters): add Flutterwave webhook inbound adapter`
- `fix(engine): correct reversal entry date to use reversal occurred_at`
- `docs(schema): add biller_category examples to reference guide`
- `test(adapters): add missing-fields fixture for Paystack adapter`

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`

### Pull request description

Your PR description should cover:

1. **What this PR does** - a short summary of the change
2. **Why** - the problem it solves or the use case it enables
3. **How to test it** - what a reviewer should do to verify the change works
4. **Any known limitations** - edge cases not handled, follow-up work needed

### Review process

All pull requests require at least one maintainer review before merging. For adapter contributions, reviewers will verify the adapter contract is fully implemented and the fixture files cover the required test cases. For engine contributions, the review bar is higher and may require multiple reviews.

Please be patient. Maintainers are not always available immediately. If your PR has had no activity for two weeks, a polite comment asking for a status update is welcome.

---

## 12. Issue Guidelines

### Bug reports

A good bug report includes:

- A clear description of what you expected to happen and what actually happened
- The Ledgerise version you are running
- The adapter and mode involved, if applicable
- A minimal reproduction: the smallest possible input that triggers the bug
- Relevant logs, with any sensitive data redacted

Use the bug report issue template.

### Feature requests

A good feature request includes:

- The use case or problem you are trying to solve
- Why existing functionality does not cover it
- What the proposed solution looks like, even if roughly sketched

Use the feature request issue template.

### Security vulnerabilities

Do not open a public issue for security vulnerabilities. Contact the maintainers directly at [security contact to be added]. We will acknowledge within 48 hours and work with you on a coordinated disclosure.

---

## 13. Commit Message Convention

Ledgerise uses [Conventional Commits](https://www.conventionalcommits.org/).

```
type(scope): short imperative description

Optional longer explanation of why this change was made,
what problem it solves, and any context a future reader
would find useful.

Fixes #123
```

**Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`

**Scopes:** `engine`, `schema`, `adapters`, `ui`, `docs`, `ci`, `deps`

Keep the subject line under 72 characters. Use the body for context, not for describing what the diff already shows.

---

## 14. Code Style

Ledgerise uses ESLint and Prettier for code formatting. Run the linter before committing:

```bash
npm run lint
npm run format
```

A pre-commit hook will run these automatically if you have set up the dev environment correctly.

Key conventions:

- TypeScript strict mode is enabled. No `any` types without explicit justification in a comment.
- Functions should do one thing. If a function is doing two things, split it.
- Name things for what they are, not for what they do. `settlementRecord` not `processedItem`.
- Comments explain why, not what. The code explains what. If you need a comment to explain what the code does, the code should be rewritten.
- No commented-out code in pull requests.

---

## 15. Testing Requirements

Ledgerise uses Vitest. All tests live in `tests/` directories co-located with the code they test.

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

**Coverage expectations:**

- Core engine: 90% line coverage minimum
- Adapters: all required test cases from the adapter spec must be present
- UI: component tests for any component with business logic

**Test naming convention:**

```typescript
describe('generic-webhook adapter', () => {
  describe('normalize()', () => {
    it('returns a valid canonical record for a settled payment event', () => { });
    it('returns a failure envelope when amount is missing', () => { });
    it('sets source.environment to test for sandbox transactions', () => { });
  });
});
```

Tests must be deterministic. No randomness, no real network calls, no dependency on system time without mocking.

---

## 16. Versioning

Ledgerise follows [Semantic Versioning](https://semver.org/).

- **Major version:** breaking changes to the canonical schema, the adapter interface contract, or the engine's public API
- **Minor version:** new adapters, new optional schema fields, new non-breaking engine features
- **Patch version:** bug fixes, documentation updates, dependency updates

The canonical transaction schema is versioned independently from the application. Schema versions are reflected in the `$id` URI and must be incremented separately following the schema change process described in Section 8.

---

## 17. Getting Help

**GitHub Discussions** is the right place for questions about how things work, proposals for new directions, and general conversation about the project.

**GitHub Issues** is for bug reports and concrete feature requests with a clear use case.

If you are unsure whether something is a bug or expected behaviour, start in Discussions.

---

Thank you for contributing to Ledgerise. Every adapter you write is one fewer manual reconciliation process somewhere in the world.
