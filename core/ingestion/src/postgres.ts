import pg from 'pg';

import type { CanonicalTransaction } from '@ledgerise/canonical-types';
import type { CanonicalValidationError } from '@ledgerise/core-schema';

import {
  type AdapterConfigurationLookup,
  DuplicateSourceTransactionError,
  type DedupeConfidence,
  type IngestionErrorListInput,
  type IngestionErrorType,
  type IngestionRepository,
  type ListPage,
  type NewStoredCanonicalTransaction,
  type NewStoredIngestionError,
  type SaveAdapterConfigurationInput,
  type SourceIdentityLookup,
  type StoredAdapterConfiguration,
  type StoredCanonicalTransaction,
  type StoredIngestionError,
  type TransactionListInput,
  type TransactionIdentityLookup
} from './index.js';

const { Pool } = pg;

export interface PostgresIngestionRepositoryOptions {
  connectionString: string;
  max?: number;
}

interface CanonicalTransactionRow {
  id: string;
  operator_id: string;
  posting_status: 'unposted';
  dedupe_confidence: DedupeConfidence;
  canonical_record: CanonicalTransaction;
  ingested_at: Date | string;
}

interface IngestionErrorRow {
  id: string;
  operator_id: string;
  adapter_name: string;
  error_type: IngestionErrorType;
  source_system: string | null;
  source_id: string | null;
  existing_transaction_id: string | null;
  raw_record: unknown;
  validation_errors: CanonicalValidationError[];
  occurred_at: Date | string;
}

interface OperatorRow {
  id: string;
}

interface CountRow {
  total: string;
}

interface AdapterConfigurationRow {
  operator_id: string;
  name: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
  updated_at: Date | string;
}

export class PostgresIngestionRepository implements IngestionRepository {
  private readonly pool: pg.Pool;

  constructor(options: PostgresIngestionRepositoryOptions | pg.Pool) {
    this.pool =
      options instanceof Pool
        ? options
        : new Pool({
            connectionString: options.connectionString,
            max: options.max ?? 10
          });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async findOperatorIdBySlug(slug: string): Promise<string | null> {
    const result = await this.pool.query<OperatorRow>(
      'SELECT id FROM operators WHERE slug = $1 LIMIT 1',
      [slug]
    );

    return result.rows[0]?.id ?? null;
  }

  async findBySourceIdentity(
    input: SourceIdentityLookup
  ): Promise<StoredCanonicalTransaction | null> {
    const result = await this.pool.query<CanonicalTransactionRow>(
      `
        SELECT id, operator_id, posting_status, dedupe_confidence, canonical_record, ingested_at
        FROM canonical_transactions
        WHERE operator_id = $1
          AND source_system = $2
          AND source_adapter = $3
          AND source_id = $4
        LIMIT 1
      `,
      [input.operatorId, input.sourceSystem, input.sourceAdapter, input.sourceId]
    );

    return result.rows[0] ? toStoredTransaction(result.rows[0]) : null;
  }

  async findTransactionById(
    input: TransactionIdentityLookup
  ): Promise<StoredCanonicalTransaction | null> {
    const result = await this.pool.query<CanonicalTransactionRow>(
      `
        SELECT id, operator_id, posting_status, dedupe_confidence, canonical_record, ingested_at
        FROM canonical_transactions
        WHERE operator_id = $1
          AND id = $2
        LIMIT 1
      `,
      [input.operatorId, input.transactionId]
    );

    return result.rows[0] ? toStoredTransaction(result.rows[0]) : null;
  }

  async listTransactions(
    input: TransactionListInput
  ): Promise<ListPage<StoredCanonicalTransaction>> {
    const { limit, offset } = normalizePagination(input);
    const filters = buildTransactionFilters(input);

    const result = await this.pool.query<CanonicalTransactionRow>(
      `
        SELECT id, operator_id, posting_status, dedupe_confidence, canonical_record, ingested_at
        FROM canonical_transactions
        WHERE ${filters.whereClause}
        ORDER BY occurred_at DESC, ingested_at DESC
        LIMIT $${filters.nextParameterIndex}
        OFFSET $${filters.nextParameterIndex + 1}
      `,
      [...filters.values, limit, offset]
    );

    const countResult = await this.pool.query<CountRow>(
      `
        SELECT COUNT(*)::text AS total
        FROM canonical_transactions
        WHERE ${filters.whereClause}
      `,
      filters.values
    );

    return {
      records: result.rows.map(toStoredTransaction),
      page: {
        limit,
        offset,
        total: Number(countResult.rows[0]?.total ?? 0)
      }
    };
  }

  async listIngestionErrors(
    input: IngestionErrorListInput
  ): Promise<ListPage<StoredIngestionError>> {
    const { limit, offset } = normalizePagination(input);
    const filters = buildIngestionErrorFilters(input);

    const result = await this.pool.query<IngestionErrorRow>(
      `
        SELECT
          id,
          operator_id,
          adapter_name,
          error_type,
          source_system,
          source_id,
          existing_transaction_id,
          raw_record,
          validation_errors,
          occurred_at
        FROM transaction_ingestion_errors
        WHERE ${filters.whereClause}
        ORDER BY occurred_at DESC, created_at DESC
        LIMIT $${filters.nextParameterIndex}
        OFFSET $${filters.nextParameterIndex + 1}
      `,
      [...filters.values, limit, offset]
    );

    const countResult = await this.pool.query<CountRow>(
      `
        SELECT COUNT(*)::text AS total
        FROM transaction_ingestion_errors
        WHERE ${filters.whereClause}
      `,
      filters.values
    );

    return {
      records: result.rows.map(toStoredIngestionError),
      page: {
        limit,
        offset,
        total: Number(countResult.rows[0]?.total ?? 0)
      }
    };
  }

  async saveTransaction(
    input: NewStoredCanonicalTransaction
  ): Promise<StoredCanonicalTransaction> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query<CanonicalTransactionRow>(
        `
          INSERT INTO canonical_transactions (
            id,
            operator_id,
            source_system,
            source_adapter,
            source_id,
            source_environment,
            status,
            type,
            direction,
            amount,
            currency,
            product_line,
            product_biller,
            product_biller_category,
            occurred_at,
            settled_at,
            posting_status,
            dedupe_confidence,
            canonical_record,
            ingested_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, 'unposted', $17, $18, $19
          )
          ON CONFLICT DO NOTHING
          RETURNING id, operator_id, posting_status, dedupe_confidence, canonical_record, ingested_at
        `,
        [
          input.record.id,
          input.operatorId,
          input.record.source.system,
          input.record.source.adapter,
          input.record.source_id ?? null,
          input.record.source.environment ?? 'live',
          input.record.status,
          input.record.type,
          input.record.direction,
          input.record.amount,
          input.record.currency,
          input.record.product.line,
          input.record.product.biller ?? null,
          input.record.product.biller_category ?? null,
          input.record.occurred_at,
          input.record.settled_at,
          input.dedupeConfidence,
          JSON.stringify(input.record),
          input.ingestedAt
        ]
      );

      if (result.rows[0]) {
        await client.query('COMMIT');
        return toStoredTransaction(result.rows[0]);
      }

      const existing = input.record.source_id
        ? await findExistingBySourceIdentity(client, {
            operatorId: input.operatorId,
            sourceSystem: input.record.source.system,
            sourceAdapter: input.record.source.adapter,
            sourceId: input.record.source_id
          })
        : await findExistingById(client, input.operatorId, input.record.id);

      await client.query('COMMIT');

      if (existing) {
        throw new DuplicateSourceTransactionError(existing);
      }

      throw new Error('Transaction insert was skipped but no existing transaction was found');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveIngestionError(input: NewStoredIngestionError): Promise<StoredIngestionError> {
    const result = await this.pool.query<IngestionErrorRow>(
      `
        INSERT INTO transaction_ingestion_errors (
          operator_id,
          adapter_name,
          error_type,
          source_system,
          source_id,
          existing_transaction_id,
          raw_record,
          validation_errors,
          occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING
          id,
          operator_id,
          adapter_name,
          error_type,
          source_system,
          source_id,
          existing_transaction_id,
          raw_record,
          validation_errors,
          occurred_at
      `,
      [
        input.operatorId,
        input.adapterName,
        input.errorType,
        input.sourceSystem ?? null,
        input.sourceId ?? null,
        input.existingTransactionId ?? null,
        JSON.stringify(input.rawRecord),
        JSON.stringify(input.validationErrors),
        input.occurredAt
      ]
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error('Failed to store ingestion error');
    }

    return toStoredIngestionError(row);
  }

  async listAdapterConfigurations(operatorId: string): Promise<StoredAdapterConfiguration[]> {
    const result = await this.pool.query<AdapterConfigurationRow>(
      `
        SELECT operator_id, name, enabled, metadata, updated_at
        FROM adapters
        WHERE operator_id = $1
        ORDER BY name ASC
      `,
      [operatorId]
    );

    return result.rows.map(toStoredAdapterConfiguration);
  }

  async findAdapterConfiguration(
    input: AdapterConfigurationLookup
  ): Promise<StoredAdapterConfiguration | null> {
    const result = await this.pool.query<AdapterConfigurationRow>(
      `
        SELECT operator_id, name, enabled, metadata, updated_at
        FROM adapters
        WHERE operator_id = $1
          AND name = $2
        LIMIT 1
      `,
      [input.operatorId, input.adapterName]
    );

    return result.rows[0] ? toStoredAdapterConfiguration(result.rows[0]) : null;
  }

  async saveAdapterConfiguration(
    input: SaveAdapterConfigurationInput
  ): Promise<StoredAdapterConfiguration | null> {
    const result = await this.pool.query<AdapterConfigurationRow>(
      `
        UPDATE adapters
        SET
          enabled = COALESCE($3, enabled),
          metadata = jsonb_set(metadata, '{config}', $4::jsonb, true),
          updated_at = now()
        WHERE operator_id = $1
          AND name = $2
        RETURNING operator_id, name, enabled, metadata, updated_at
      `,
      [input.operatorId, input.adapterName, input.enabled ?? null, JSON.stringify(input.config ?? {})]
    );

    return result.rows[0] ? toStoredAdapterConfiguration(result.rows[0]) : null;
  }
}

async function findExistingBySourceIdentity(
  client: pg.PoolClient,
  input: SourceIdentityLookup
): Promise<StoredCanonicalTransaction | null> {
  const result = await client.query<CanonicalTransactionRow>(
    `
      SELECT id, operator_id, posting_status, dedupe_confidence, canonical_record, ingested_at
      FROM canonical_transactions
      WHERE operator_id = $1
        AND source_system = $2
        AND source_adapter = $3
        AND source_id = $4
      LIMIT 1
    `,
    [input.operatorId, input.sourceSystem, input.sourceAdapter, input.sourceId]
  );

  return result.rows[0] ? toStoredTransaction(result.rows[0]) : null;
}

async function findExistingById(
  client: pg.PoolClient,
  operatorId: string,
  transactionId: string
): Promise<StoredCanonicalTransaction | null> {
  const result = await client.query<CanonicalTransactionRow>(
    `
      SELECT id, operator_id, posting_status, dedupe_confidence, canonical_record, ingested_at
      FROM canonical_transactions
      WHERE operator_id = $1
        AND id = $2
      LIMIT 1
    `,
    [operatorId, transactionId]
  );

  return result.rows[0] ? toStoredTransaction(result.rows[0]) : null;
}

function toStoredTransaction(row: CanonicalTransactionRow): StoredCanonicalTransaction {
  return {
    id: row.id,
    operatorId: row.operator_id,
    record: row.canonical_record,
    postingStatus: row.posting_status,
    dedupeConfidence: row.dedupe_confidence,
    ingestedAt: toIsoString(row.ingested_at)
  };
}

function toStoredIngestionError(row: IngestionErrorRow): StoredIngestionError {
  return {
    id: row.id,
    operatorId: row.operator_id,
    adapterName: row.adapter_name,
    errorType: row.error_type,
    sourceSystem: row.source_system ?? undefined,
    sourceId: row.source_id ?? undefined,
    existingTransactionId: row.existing_transaction_id ?? undefined,
    rawRecord: row.raw_record,
    validationErrors: row.validation_errors,
    occurredAt: toIsoString(row.occurred_at)
  };
}

function toStoredAdapterConfiguration(row: AdapterConfigurationRow): StoredAdapterConfiguration {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  return {
    operatorId: row.operator_id,
    name: row.name,
    enabled: row.enabled,
    config: metadata.config ?? {},
    metadata,
    updatedAt: toIsoString(row.updated_at)
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function normalizePagination(input: { limit?: number; offset?: number }) {
  return {
    limit: input.limit ?? 100,
    offset: input.offset ?? 0
  };
}

function buildTransactionFilters(input: TransactionListInput) {
  const values: unknown[] = [input.operatorId];
  const clauses = ['operator_id = $1'];

  appendFilter(clauses, values, 'status', input.status);
  appendFilter(clauses, values, 'posting_status', input.postingStatus);
  appendFilter(clauses, values, 'product_line', input.productLine);
  appendFilter(clauses, values, 'product_biller', input.biller);
  appendFilter(clauses, values, 'source_adapter', input.adapter);
  appendFilter(clauses, values, 'source_environment', input.environment);
  appendDateFilter(clauses, values, 'occurred_at', '>=', input.occurredFrom);
  appendDateFilter(clauses, values, 'occurred_at', '<=', input.occurredTo);

  return {
    whereClause: clauses.join(' AND '),
    values,
    nextParameterIndex: values.length + 1
  };
}

function buildIngestionErrorFilters(input: IngestionErrorListInput) {
  const values: unknown[] = [input.operatorId];
  const clauses = ['operator_id = $1'];

  appendFilter(clauses, values, 'adapter_name', input.adapterName);
  appendFilter(clauses, values, 'error_type', input.errorType);
  appendFilter(clauses, values, 'source_system', input.sourceSystem);
  appendFilter(clauses, values, 'source_id', input.sourceId);
  appendDateFilter(clauses, values, 'occurred_at', '>=', input.occurredFrom);
  appendDateFilter(clauses, values, 'occurred_at', '<=', input.occurredTo);

  return {
    whereClause: clauses.join(' AND '),
    values,
    nextParameterIndex: values.length + 1
  };
}

function appendFilter(
  clauses: string[],
  values: unknown[],
  column: string,
  value: string | undefined
) {
  if (!value) {
    return;
  }

  values.push(value);
  clauses.push(`${column} = $${values.length}`);
}

function appendDateFilter(
  clauses: string[],
  values: unknown[],
  column: string,
  operator: '>=' | '<=',
  value: string | undefined
) {
  if (!value) {
    return;
  }

  values.push(value);
  clauses.push(`${column} ${operator} $${values.length}`);
}
