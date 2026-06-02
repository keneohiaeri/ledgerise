import { randomUUID } from 'node:crypto';

import pg from 'pg';

import {
  type ApiKeyPrincipal,
  type ApiScope,
  type CompletePostingBatchInput,
  type CreatePostingBatchInput,
  type JournalLogEntry,
  type JournalLogLine,
  type ListJournalEntriesInput,
  type ListPostingBatchesInput,
  type ListPage,
  type ManualRetryInput,
  type PostingAttempt,
  type PostingArtifact,
  type PostingAttemptStatus,
  type PostingBatch,
  type PostingBatchStatus,
  type PostingRepository,
  type RecordPostingArtifactDownloadInput,
  type SavePostingArtifactInput,
  type PostingStatus
} from './index.js';

const { Pool } = pg;

export interface PostgresPostingRepositoryOptions {
  connectionString: string;
  max?: number;
}

interface JournalLogRow {
  id: string;
  operator_id: string;
  transaction_id: string;
  entry_type: JournalLogEntry['entryType'];
  status: JournalLogEntry['status'];
  posting_status: PostingStatus;
  currency: string;
  amount: string;
  mapping_rule_id: string | null;
  mapping_rule_version: number | null;
  reversal_of_journal_entry_id: string | null;
  generated_at: Date | string;
  posted_at: Date | string | null;
  last_posting_attempt_at: Date | string | null;
  last_posting_error: string | null;
  source_id: string | null;
  transaction_status: string | null;
  transaction_type: string | null;
  occurred_at: Date | string | null;
  settled_at: Date | string | null;
  source_adapter: string | null;
  source_system: string | null;
  product_line: string | null;
  product_biller: string | null;
  product_biller_category: string | null;
  attempt_count: string;
  lines: unknown;
  attempts: unknown;
  latest_attempt: unknown;
}

interface CountRow {
  total: string;
}

interface AttemptNumberRow {
  attempt_number: number | null;
}

interface PostingBatchRow {
  id: string;
  operator_id: string;
  adapter_name: string;
  status: PostingBatchStatus;
  journal_entry_count: number;
  idempotency_key: string | null;
  created_by_api_key_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ClaimedJournalEntryRow {
  id: string;
}

interface ApiKeyRow {
  id: string;
  operator_id: string;
  name: string;
  scopes: string[];
}

interface PostingArtifactRow {
  id: string;
  operator_id: string;
  posting_batch_id: string;
  content_type: string;
  filename: string;
  content: Buffer;
  checksum_sha256: string;
  size_bytes: number;
  row_count: number;
  created_by_api_key_id: string | null;
  created_at: Date | string;
}

export class PostgresPostingRepository implements PostingRepository {
  private readonly pool: pg.Pool;

  constructor(options: PostgresPostingRepositoryOptions | pg.Pool) {
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

  async authenticateApiKey(input: {
    keyHash: string;
    requiredScope: ApiScope;
    occurredAt: string;
  }): Promise<ApiKeyPrincipal | null> {
    const result = await this.pool.query<ApiKeyRow>(
      `
        UPDATE api_keys
        SET last_used_at = $3, updated_at = now()
        WHERE
          key_hash = $1
          AND enabled = true
          AND (expires_at IS NULL OR expires_at > $3)
          AND $2 = ANY(scopes)
        RETURNING id, operator_id, name, scopes
      `,
      [input.keyHash, input.requiredScope, input.occurredAt]
    );
    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      operatorId: row.operator_id,
      name: row.name,
      scopes: row.scopes as ApiScope[]
    };
  }

  async listJournalEntries(
    input: ListJournalEntriesInput & {
      limit: number;
      offset: number;
    }
  ): Promise<ListPage<JournalLogEntry>> {
    const filters = buildJournalFilters(input);
    const result = await this.pool.query<JournalLogRow>(
      `
        SELECT ${journalLogSelectColumns}
        FROM journal_entries
        LEFT JOIN canonical_transactions
          ON canonical_transactions.operator_id = journal_entries.operator_id
          AND canonical_transactions.id = journal_entries.transaction_id
        WHERE ${filters.whereClause}
        ORDER BY generated_at DESC
        LIMIT $${filters.nextParameterIndex}
        OFFSET $${filters.nextParameterIndex + 1}
      `,
      [...filters.values, input.limit, input.offset]
    );

    const countResult = await this.pool.query<CountRow>(
      `
        SELECT COUNT(*)::text AS total
        FROM journal_entries
        LEFT JOIN canonical_transactions
          ON canonical_transactions.operator_id = journal_entries.operator_id
          AND canonical_transactions.id = journal_entries.transaction_id
        WHERE ${filters.whereClause}
      `,
      filters.values
    );

    return {
      records: result.rows.map(toJournalLogEntry),
      page: {
        limit: input.limit,
        offset: input.offset,
        total: Number(countResult.rows[0]?.total ?? 0)
      }
    };
  }

  async findJournalEntry(input: {
    operatorId: string;
    journalEntryId: string;
  }): Promise<JournalLogEntry | null> {
    const result = await this.pool.query<JournalLogRow>(
      `
        SELECT ${journalLogSelectColumns}
        FROM journal_entries
        LEFT JOIN canonical_transactions
          ON canonical_transactions.operator_id = journal_entries.operator_id
          AND canonical_transactions.id = journal_entries.transaction_id
        WHERE journal_entries.operator_id = $1 AND journal_entries.id = $2
        LIMIT 1
      `,
      [input.operatorId, input.journalEntryId]
    );

    return result.rows[0] ? toJournalLogEntry(result.rows[0]) : null;
  }

  async requestManualRetry(input: ManualRetryInput & {
    occurredAt: string;
  }): Promise<JournalLogEntry | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const locked = await client.query<{ posting_status: PostingStatus }>(
        `
          SELECT posting_status
          FROM journal_entries
          WHERE operator_id = $1 AND id = $2
          FOR UPDATE
        `,
        [input.operatorId, input.journalEntryId]
      );

      const row = locked.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }

      if (!['failed', 'retry_exhausted'].includes(row.posting_status)) {
        throw new Error(`Journal entry is ${row.posting_status}, not retryable`);
      }

      const attemptResult = await client.query<AttemptNumberRow>(
        `
          SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
          FROM posting_attempts
          WHERE journal_entry_id = $1
        `,
        [input.journalEntryId]
      );
      const attemptNumber = attemptResult.rows[0]?.attempt_number ?? 1;

      await client.query(
        `
          INSERT INTO posting_attempts (
            operator_id,
            journal_entry_id,
            adapter_name,
            status,
            attempt_number,
            requested_by_user_id,
            occurred_at
          )
          VALUES ($1, $2, $3, 'retry_requested', $4, $5, $6)
        `,
        [
          input.operatorId,
          input.journalEntryId,
          input.adapterName,
          attemptNumber,
          input.requestedByUserId || null,
          input.occurredAt
        ]
      );

      await client.query(
        `
          UPDATE journal_entries
          SET
            posting_status = 'generated',
            last_posting_attempt_at = $3,
            last_posting_error = NULL,
            updated_at = now()
          WHERE operator_id = $1 AND id = $2
        `,
        [input.operatorId, input.journalEntryId, input.occurredAt]
      );

      await client.query(
        `
          INSERT INTO audit_events (
            operator_id,
            actor_id,
            event_type,
            entity_type,
            entity_id,
            metadata
          )
          VALUES ($1, $2, 'posting.manual_retry_requested', 'journal_entry', $3, $4)
        `,
        [
          input.operatorId,
          input.requestedByUserId || null,
          input.journalEntryId,
          JSON.stringify({ adapterName: input.adapterName, attemptNumber })
        ]
      );

      const reloaded = await findJournalEntry(client, input.operatorId, input.journalEntryId);
      await client.query('COMMIT');
      return reloaded;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createPostingBatch(input: CreatePostingBatchInput & {
    limit: number;
    occurredAt: string;
  }): Promise<PostingBatch> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      if (input.idempotencyKey) {
        const existing = await client.query<PostingBatchRow>(
          `
            SELECT *
            FROM posting_batches
            WHERE operator_id = $1 AND adapter_name = $2 AND idempotency_key = $3
            LIMIT 1
          `,
          [input.operatorId, input.adapterName, input.idempotencyKey]
        );
        const existingRow = existing.rows[0];
        if (existingRow) {
          const batch = await findPostingBatch(client, input.operatorId, existingRow.id);
          await client.query('COMMIT');
          return batch ? { ...batch, replayed: true } : { ...toPostingBatch(existingRow, []), replayed: true };
        }
      }

      const claimed = await client.query<ClaimedJournalEntryRow>(
        `
          SELECT id
          FROM journal_entries
          WHERE
            operator_id = $1
            AND status = 'generated'
            AND posting_status = 'generated'
            AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
          ORDER BY generated_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        `,
        [input.operatorId, input.limit, input.journalEntryIds ?? null]
      );
      const journalEntryIds = claimed.rows.map((row) => row.id);
      if (journalEntryIds.length === 0) {
        await client.query('COMMIT');
        return {
          id: randomUUID(),
          operatorId: input.operatorId,
          adapterName: input.adapterName,
          status: 'posting',
          journalEntryCount: 0,
          createdAt: input.occurredAt,
          updatedAt: input.occurredAt,
          entries: []
        };
      }

      const batchResult = await client.query<PostingBatchRow>(
        `
          INSERT INTO posting_batches (
            operator_id,
            adapter_name,
            status,
            journal_entry_count,
            idempotency_key,
            created_by_api_key_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, 'posting', $3, $4, $5, $6, $6)
          RETURNING *
        `,
        [
          input.operatorId,
          input.adapterName,
          journalEntryIds.length,
          input.idempotencyKey || null,
          input.createdByApiKeyId || null,
          input.occurredAt
        ]
      );
      const batchRow = batchResult.rows[0];
      if (!batchRow) {
        throw new Error('Posting batch insert did not return a row');
      }

      for (const journalEntryId of journalEntryIds) {
        const attemptResult = await client.query<AttemptNumberRow>(
          `
            SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
            FROM posting_attempts
            WHERE journal_entry_id = $1
          `,
          [journalEntryId]
        );
        const attemptNumber = attemptResult.rows[0]?.attempt_number ?? 1;

        await client.query(
          `
            INSERT INTO posting_attempts (
              operator_id,
              journal_entry_id,
              posting_batch_id,
              adapter_name,
              status,
              attempt_number,
              occurred_at
            )
            VALUES ($1, $2, $3, $4, 'posting', $5, $6)
          `,
          [
            input.operatorId,
            journalEntryId,
            batchRow.id,
            input.adapterName,
            attemptNumber,
            input.occurredAt
          ]
        );
      }

      if (journalEntryIds.length > 0) {
        await client.query(
          `
            UPDATE journal_entries
            SET
              posting_status = 'posting',
              last_posting_attempt_at = $3,
              last_posting_error = NULL,
              updated_at = now()
            WHERE operator_id = $1 AND id = ANY($2::uuid[])
          `,
          [input.operatorId, journalEntryIds, input.occurredAt]
        );
      }

      const batch = await findPostingBatch(client, input.operatorId, batchRow.id);
      await client.query('COMMIT');
      return batch ?? toPostingBatch(batchRow, []);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completePostingBatch(input: CompletePostingBatchInput & {
    occurredAt: string;
  }): Promise<PostingBatch | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const batchResult = await client.query<PostingBatchRow>(
        `
          SELECT *
          FROM posting_batches
          WHERE operator_id = $1 AND id = $2 AND adapter_name = $3
          FOR UPDATE
        `,
        [input.operatorId, input.batchId, input.adapterName]
      );
      const batchRow = batchResult.rows[0];
      if (!batchRow) {
        await client.query('COMMIT');
        return null;
      }

      for (const result of input.results) {
        await client.query(
          `
            UPDATE posting_attempts
            SET
              status = $5,
              external_reference = $6,
              error_code = $7,
              error_message = $8,
              occurred_at = $9
            WHERE
              operator_id = $1
              AND posting_batch_id = $2
              AND adapter_name = $3
              AND journal_entry_id = $4
          `,
          [
            input.operatorId,
            input.batchId,
            input.adapterName,
            result.journalEntryId,
            result.status,
            result.externalReference || null,
            result.errorCode || null,
            result.errorMessage || null,
            input.occurredAt
          ]
        );

        await client.query(
          `
            UPDATE journal_entries
            SET
              posting_status = $3,
              posted_at = CASE WHEN $3 = 'posted' THEN $4::timestamptz ELSE posted_at END,
              last_posting_attempt_at = $4,
              last_posting_error = CASE WHEN $3 = 'failed' THEN $5 ELSE NULL END,
              updated_at = now()
            WHERE operator_id = $1 AND id = $2 AND posting_status = 'posting'
          `,
          [
            input.operatorId,
            result.journalEntryId,
            result.status,
            input.occurredAt,
            result.errorMessage || null
          ]
        );
      }

      const batchStatus = input.results.some((result) => result.status === 'failed') ? 'failed' : 'posted';
      await client.query(
        `
          UPDATE posting_batches
          SET status = $3, updated_at = $4
          WHERE operator_id = $1 AND id = $2
        `,
        [input.operatorId, input.batchId, batchStatus, input.occurredAt]
      );

      await client.query(
        `
          INSERT INTO audit_events (
            operator_id,
            event_type,
            entity_type,
            entity_id,
            metadata
          )
          VALUES ($1, 'posting.batch_completed', 'posting_batch', $2, $3)
        `,
        [
          input.operatorId,
          input.batchId,
          JSON.stringify({
            adapterName: input.adapterName,
            status: batchStatus,
            resultCount: input.results.length
          })
        ]
      );

      const batch = await findPostingBatch(client, input.operatorId, input.batchId);
      await client.query('COMMIT');
      return batch;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listPostingBatches(input: ListPostingBatchesInput & {
    limit: number;
    offset: number;
  }): Promise<ListPage<PostingBatch>> {
    const result = await this.pool.query<PostingBatchRow>(
      `
        SELECT *
        FROM posting_batches
        WHERE operator_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        OFFSET $3
      `,
      [input.operatorId, input.limit, input.offset]
    );
    const countResult = await this.pool.query<CountRow>(
      `
        SELECT COUNT(*)::text AS total
        FROM posting_batches
        WHERE operator_id = $1
      `,
      [input.operatorId]
    );

    return {
      records: await Promise.all(
        result.rows.map(async (row) => {
          const batch = await findPostingBatch(this.pool, input.operatorId, row.id);
          return batch ?? toPostingBatch(row, []);
        })
      ),
      page: {
        limit: input.limit,
        offset: input.offset,
        total: Number(countResult.rows[0]?.total ?? 0)
      }
    };
  }

  findPostingBatch(input: {
    operatorId: string;
    batchId: string;
  }): Promise<PostingBatch | null> {
    return findPostingBatch(this.pool, input.operatorId, input.batchId);
  }

  async savePostingArtifact(input: SavePostingArtifactInput & {
    createdAt: string;
  }): Promise<PostingArtifact> {
    const result = await this.pool.query<PostingArtifactRow>(
      `
        INSERT INTO posting_artifacts (
          operator_id,
          posting_batch_id,
          content_type,
          filename,
          content,
          checksum_sha256,
          size_bytes,
          row_count,
          created_by_api_key_id,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (operator_id, posting_batch_id)
        DO UPDATE SET filename = posting_artifacts.filename
        RETURNING *
      `,
      [
        input.operatorId,
        input.postingBatchId,
        input.contentType,
        input.filename,
        Buffer.from(input.content, 'utf8'),
        input.checksumSha256,
        input.sizeBytes,
        input.rowCount,
        input.createdByApiKeyId || null,
        input.createdAt
      ]
    );

    const row = result.rows[0];
    if (!row) throw new Error('Posting artifact insert did not return a row');
    return toPostingArtifact(row);
  }

  async findPostingArtifactByBatchId(input: {
    operatorId: string;
    batchId: string;
  }): Promise<PostingArtifact | null> {
    const result = await this.pool.query<PostingArtifactRow>(
      `
        SELECT *
        FROM posting_artifacts
        WHERE operator_id = $1 AND posting_batch_id = $2
        LIMIT 1
      `,
      [input.operatorId, input.batchId]
    );
    return result.rows[0] ? toPostingArtifact(result.rows[0]) : null;
  }

  async recordPostingArtifactDownload(input: RecordPostingArtifactDownloadInput & {
    downloadedAt: string;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO posting_artifact_downloads (
          operator_id,
          posting_artifact_id,
          posting_batch_id,
          api_key_id,
          user_agent,
          remote_addr,
          downloaded_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        input.operatorId,
        input.postingArtifactId,
        input.postingBatchId,
        input.apiKeyId || null,
        input.userAgent || null,
        input.remoteAddr || null,
        input.downloadedAt
      ]
    );
  }
}

const journalLogSelectColumns = `
  journal_entries.id,
  journal_entries.operator_id,
  journal_entries.transaction_id,
  journal_entries.entry_type,
  journal_entries.status,
  journal_entries.posting_status,
  journal_entries.currency,
  journal_entries.amount::text,
  journal_entries.mapping_rule_id,
  journal_entries.mapping_rule_version,
  journal_entries.reversal_of_journal_entry_id,
  journal_entries.generated_at,
  journal_entries.posted_at,
  journal_entries.last_posting_attempt_at,
  journal_entries.last_posting_error,
  canonical_transactions.source_id,
  canonical_transactions.status AS transaction_status,
  canonical_transactions.type AS transaction_type,
  canonical_transactions.occurred_at,
  canonical_transactions.settled_at,
  canonical_transactions.source_adapter,
  canonical_transactions.source_system,
  canonical_transactions.product_line,
  canonical_transactions.product_biller,
  canonical_transactions.product_biller_category,
  (
    SELECT COUNT(*)::text
    FROM posting_attempts
    WHERE posting_attempts.journal_entry_id = journal_entries.id
  ) AS attempt_count,
  (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'accountCode', account_code,
          'side', side,
          'amount', amount,
          'currency', currency,
          'lineOrder', line_order
        )
        ORDER BY line_order
      ),
      '[]'::jsonb
    )
    FROM journal_entry_lines
    WHERE journal_entry_lines.journal_entry_id = journal_entries.id
  ) AS lines,
  (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', id,
          'operatorId', operator_id,
          'journalEntryId', journal_entry_id,
          'postingBatchId', posting_batch_id,
          'adapterName', adapter_name,
          'status', status,
          'attemptNumber', attempt_number,
          'externalReference', external_reference,
          'errorCode', error_code,
          'errorMessage', error_message,
          'requestedByUserId', requested_by_user_id,
          'occurredAt', occurred_at
        )
        ORDER BY attempt_number DESC
      ),
      '[]'::jsonb
    )
    FROM posting_attempts
    WHERE posting_attempts.journal_entry_id = journal_entries.id
  ) AS attempts,
  (
    SELECT jsonb_build_object(
      'id', id,
      'operatorId', operator_id,
      'journalEntryId', journal_entry_id,
      'postingBatchId', posting_batch_id,
      'adapterName', adapter_name,
      'status', status,
      'attemptNumber', attempt_number,
      'externalReference', external_reference,
      'errorCode', error_code,
      'errorMessage', error_message,
      'requestedByUserId', requested_by_user_id,
      'occurredAt', occurred_at
    )
    FROM posting_attempts
    WHERE posting_attempts.journal_entry_id = journal_entries.id
    ORDER BY attempt_number DESC
    LIMIT 1
  ) AS latest_attempt
`;

async function findJournalEntry(
  queryable: pg.PoolClient,
  operatorId: string,
  journalEntryId: string
): Promise<JournalLogEntry | null> {
  const result = await queryable.query<JournalLogRow>(
    `
      SELECT ${journalLogSelectColumns}
      FROM journal_entries
      LEFT JOIN canonical_transactions
        ON canonical_transactions.operator_id = journal_entries.operator_id
        AND canonical_transactions.id = journal_entries.transaction_id
      WHERE journal_entries.operator_id = $1 AND journal_entries.id = $2
      LIMIT 1
    `,
    [operatorId, journalEntryId]
  );

  return result.rows[0] ? toJournalLogEntry(result.rows[0]) : null;
}

async function findPostingBatch(
  queryable: pg.PoolClient | pg.Pool,
  operatorId: string,
  batchId: string
): Promise<PostingBatch | null> {
  const batchResult = await queryable.query<PostingBatchRow>(
    `
      SELECT *
      FROM posting_batches
      WHERE operator_id = $1 AND id = $2
      LIMIT 1
    `,
    [operatorId, batchId]
  );
  const batchRow = batchResult.rows[0];
  if (!batchRow) return null;

  const entriesResult = await queryable.query<JournalLogRow>(
    `
      SELECT ${journalLogSelectColumns}
      FROM journal_entries
      LEFT JOIN canonical_transactions
        ON canonical_transactions.operator_id = journal_entries.operator_id
        AND canonical_transactions.id = journal_entries.transaction_id
      WHERE
        journal_entries.operator_id = $1
        AND EXISTS (
          SELECT 1
          FROM posting_attempts
          WHERE
            posting_attempts.journal_entry_id = journal_entries.id
            AND posting_attempts.posting_batch_id = $2
        )
      ORDER BY generated_at ASC
    `,
    [operatorId, batchId]
  );

  return toPostingBatch(batchRow, entriesResult.rows.map(toJournalLogEntry));
}

function toPostingBatch(row: PostingBatchRow, entries: JournalLogEntry[]): PostingBatch {
  return {
    id: row.id,
    operatorId: row.operator_id,
    adapterName: row.adapter_name,
    status: row.status,
    journalEntryCount: row.journal_entry_count,
    idempotencyKey: row.idempotency_key ?? undefined,
    createdByApiKeyId: row.created_by_api_key_id ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    entries
  };
}

function toPostingArtifact(row: PostingArtifactRow): PostingArtifact {
  return {
    id: row.id,
    operatorId: row.operator_id,
    postingBatchId: row.posting_batch_id,
    contentType: row.content_type,
    filename: row.filename,
    content: row.content.toString('utf8'),
    checksumSha256: row.checksum_sha256,
    sizeBytes: row.size_bytes,
    rowCount: row.row_count,
    createdByApiKeyId: row.created_by_api_key_id ?? undefined,
    createdAt: toIsoString(row.created_at)
  };
}

function buildJournalFilters(input: ListJournalEntriesInput) {
  const values: unknown[] = [input.operatorId];
  const clauses = ['journal_entries.operator_id = $1'];

  if (input.postingStatus) {
    values.push(input.postingStatus);
    clauses.push(`journal_entries.posting_status = $${values.length}`);
  }

  return {
    whereClause: clauses.join(' AND '),
    values,
    nextParameterIndex: values.length + 1
  };
}

function toJournalLogEntry(row: JournalLogRow): JournalLogEntry {
  return {
    id: row.id,
    operatorId: row.operator_id,
    transactionId: row.transaction_id,
    entryType: row.entry_type,
    status: row.status,
    postingStatus: row.posting_status,
    currency: row.currency,
    amount: Number(row.amount),
    mappingRuleId: row.mapping_rule_id ?? undefined,
    mappingRuleVersion: row.mapping_rule_version ?? undefined,
    reversalOfJournalEntryId: row.reversal_of_journal_entry_id ?? undefined,
    generatedAt: toIsoString(row.generated_at),
    postedAt: row.posted_at ? toIsoString(row.posted_at) : undefined,
    lastPostingAttemptAt: row.last_posting_attempt_at
      ? toIsoString(row.last_posting_attempt_at)
      : undefined,
    lastPostingError: row.last_posting_error ?? undefined,
    attemptCount: Number(row.attempt_count),
    lines: parseJournalLines(row.lines),
    transaction: parseTransaction(row),
    attempts: parseAttempts(row.attempts),
    latestAttempt: parseLatestAttempt(row.latest_attempt)
  };
}

function parseTransaction(row: JournalLogRow): JournalLogEntry['transaction'] {
  if (!row.transaction_type || !row.occurred_at || !row.product_line) return undefined;

  return {
    id: row.transaction_id,
    sourceId: row.source_id ?? undefined,
    status: row.transaction_status ?? '',
    type: row.transaction_type,
    occurredAt: toIsoString(row.occurred_at),
    settledAt: row.settled_at ? toIsoString(row.settled_at) : undefined,
    sourceAdapter: row.source_adapter ?? '',
    sourceSystem: row.source_system ?? '',
    productLine: row.product_line,
    productBiller: row.product_biller ?? undefined,
    productBillerCategory: row.product_biller_category ?? undefined
  };
}

function parseJournalLines(value: unknown): JournalLogLine[] {
  if (!Array.isArray(value)) return [];

  return value.map((line) => {
    const item = line as {
      accountCode: string;
      side: JournalLogLine['side'];
      amount: string | number;
      currency: string;
      lineOrder: number;
    };
    return {
      accountCode: item.accountCode,
      side: item.side,
      amount: Number(item.amount),
      currency: item.currency,
      lineOrder: item.lineOrder
    };
  });
}

function parseLatestAttempt(value: unknown): PostingAttempt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as {
    id: string;
    operatorId: string;
    journalEntryId: string;
    postingBatchId: string | null;
    adapterName: string;
    status: PostingAttemptStatus;
    attemptNumber: number;
    externalReference: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    requestedByUserId: string | null;
    occurredAt: Date | string;
  };

  return {
    id: item.id,
    operatorId: item.operatorId,
    journalEntryId: item.journalEntryId,
    postingBatchId: item.postingBatchId ?? undefined,
    adapterName: item.adapterName,
    status: item.status,
    attemptNumber: item.attemptNumber,
    externalReference: item.externalReference ?? undefined,
    errorCode: item.errorCode ?? undefined,
    errorMessage: item.errorMessage ?? undefined,
    requestedByUserId: item.requestedByUserId ?? undefined,
    occurredAt: toIsoString(item.occurredAt)
  };
}

function parseAttempts(value: unknown): PostingAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseAttempt).filter((attempt): attempt is PostingAttempt => Boolean(attempt));
}

function parseAttempt(value: unknown): PostingAttempt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as {
    id: string;
    operatorId: string;
    journalEntryId: string;
    postingBatchId: string | null;
    adapterName: string;
    status: PostingAttemptStatus;
    attemptNumber: number;
    externalReference: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    requestedByUserId: string | null;
    occurredAt: Date | string;
  };

  return {
    id: item.id,
    operatorId: item.operatorId,
    journalEntryId: item.journalEntryId,
    postingBatchId: item.postingBatchId ?? undefined,
    adapterName: item.adapterName,
    status: item.status,
    attemptNumber: item.attemptNumber,
    externalReference: item.externalReference ?? undefined,
    errorCode: item.errorCode ?? undefined,
    errorMessage: item.errorMessage ?? undefined,
    requestedByUserId: item.requestedByUserId ?? undefined,
    occurredAt: toIsoString(item.occurredAt)
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
