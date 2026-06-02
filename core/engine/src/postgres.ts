import pg from 'pg';

import type { CanonicalTransaction } from '@ledgerise/canonical-types';
import type { JournalEntryTemplate, MappingRule, MappingRuleStatus } from '@ledgerise/core-mapping';

import type {
  EngineTransaction,
  JournalEngineRepository,
  JournalEntry,
  JournalEntryLine,
  JournalEntryStatus,
  JournalEntryType,
  JournalLineSide,
  NewJournalEntry
} from './index.js';

const { Pool } = pg;

export interface PostgresJournalEngineRepositoryOptions {
  connectionString: string;
  max?: number;
}

interface TransactionRow {
  id: string;
  operator_id: string;
  canonical_record: CanonicalTransaction;
}

interface MappingRuleRow {
  id: string;
  operator_id: string;
  product_line: string;
  biller: string | null;
  biller_category: string | null;
  transaction_type: string | null;
  rule_type: 'simple' | 'compound';
  entries: unknown;
  status: MappingRuleStatus;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface JournalEntryRow {
  id: string;
  operator_id: string;
  transaction_id: string;
  entry_type: JournalEntryType;
  status: JournalEntryStatus;
  currency: string;
  amount: string;
  mapping_rule_id: string | null;
  mapping_rule_version: number | null;
  reversal_of_journal_entry_id: string | null;
  entry_order: number;
  entry_label: string | null;
  generated_at: Date | string;
  lines: unknown;
}

export class PostgresJournalEngineRepository implements JournalEngineRepository {
  private readonly pool: pg.Pool;

  constructor(options: PostgresJournalEngineRepositoryOptions | pg.Pool) {
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

  async listEligibleTransactions(input: {
    operatorId: string;
    limit: number;
  }): Promise<EngineTransaction[]> {
    const result = await this.pool.query<TransactionRow>(
      `
        SELECT
          canonical_transactions.id,
          canonical_transactions.operator_id,
          canonical_transactions.canonical_record
        FROM canonical_transactions
        LEFT JOIN journal_entries
          ON journal_entries.operator_id = canonical_transactions.operator_id
          AND journal_entries.transaction_id = canonical_transactions.id
        WHERE canonical_transactions.operator_id = $1
          AND journal_entries.id IS NULL
          AND source_environment = 'live'
          AND (
            (canonical_transactions.status = 'settled' AND settled_at IS NOT NULL)
            OR canonical_transactions.status = 'reversed'
          )
        ORDER BY occurred_at ASC, ingested_at ASC
        LIMIT $2
      `,
      [input.operatorId, input.limit]
    );

    return result.rows.map(toEngineTransaction);
  }

  async listActiveMappingRules(operatorId: string): Promise<MappingRule[]> {
    const result = await this.pool.query<MappingRuleRow>(
      `
        SELECT ${mappingRuleSelectColumns}
        FROM mapping_rules
        WHERE operator_id = $1 AND status = 'active'
        ORDER BY product_line ASC, biller ASC NULLS LAST, biller_category ASC NULLS LAST, created_at ASC
      `,
      [operatorId]
    );

    return result.rows.map(toMappingRule);
  }

  async findJournalEntryByTransactionId(input: {
    operatorId: string;
    transactionId: string;
  }): Promise<JournalEntry | null> {
    const result = await this.pool.query<JournalEntryRow>(
      `
        SELECT ${journalEntrySelectColumns}
        FROM journal_entries
        WHERE operator_id = $1 AND transaction_id = $2
        ORDER BY entry_order ASC
        LIMIT 1
      `,
      [input.operatorId, input.transactionId]
    );

    return result.rows[0] ? toJournalEntry(result.rows[0]) : null;
  }

  async findJournalEntriesForTransaction(input: {
    operatorId: string;
    transactionId: string;
  }): Promise<JournalEntry[]> {
    const result = await this.pool.query<JournalEntryRow>(
      `
        SELECT ${journalEntrySelectColumns}
        FROM journal_entries
        WHERE operator_id = $1 AND transaction_id = $2
        ORDER BY entry_order ASC
      `,
      [input.operatorId, input.transactionId]
    );

    return result.rows.map(toJournalEntry);
  }

  async saveJournalEntries(inputs: NewJournalEntry[]): Promise<JournalEntry[]> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const saved: JournalEntry[] = [];

      for (const input of inputs) {
        const entryResult = await client.query<JournalEntryRow>(
          `
            INSERT INTO journal_entries (
              operator_id,
              transaction_id,
              entry_type,
              status,
              currency,
              amount,
              mapping_rule_id,
              mapping_rule_version,
              reversal_of_journal_entry_id,
              posting_status,
              entry_order,
              entry_label,
              generated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (operator_id, transaction_id, entry_order) DO NOTHING
            RETURNING ${journalEntrySelectColumns}
          `,
          [
            input.operatorId,
            input.transactionId,
            input.entryType,
            input.status,
            input.currency,
            input.amount,
            input.mappingRuleId ?? null,
            input.mappingRuleVersion ?? null,
            input.reversalOfJournalEntryId ?? null,
            input.status === 'unmapped' ? 'unmapped' : 'generated',
            input.entryOrder,
            input.entryLabel ?? null,
            input.generatedAt
          ]
        );

        const insertedEntry = entryResult.rows[0];
        if (!insertedEntry) continue;

        for (const line of input.lines) {
          await client.query(
            `
              INSERT INTO journal_entry_lines (
                journal_entry_id, operator_id, account_code, side, amount, currency, line_order
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7)
            `,
            [insertedEntry.id, input.operatorId, line.accountCode, line.side, line.amount, line.currency, line.lineOrder]
          );
        }

        const reloaded = await findJournalEntryById(client, input.operatorId, insertedEntry.id);
        if (reloaded) saved.push(reloaded);
      }

      await client.query('COMMIT');
      return saved;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

const mappingRuleSelectColumns = `
  id,
  operator_id,
  product_line,
  biller,
  biller_category,
  transaction_type,
  rule_type,
  entries,
  status,
  version,
  created_at,
  updated_at
`;

const journalEntrySelectColumns = `
  journal_entries.id,
  journal_entries.operator_id,
  journal_entries.transaction_id,
  journal_entries.entry_type,
  journal_entries.status,
  journal_entries.currency,
  journal_entries.amount::text,
  journal_entries.mapping_rule_id,
  journal_entries.mapping_rule_version,
  journal_entries.reversal_of_journal_entry_id,
  journal_entries.entry_order,
  journal_entries.entry_label,
  journal_entries.generated_at,
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
  ) AS lines
`;

async function findJournalEntryById(
  queryable: pg.PoolClient,
  operatorId: string,
  entryId: string
): Promise<JournalEntry | null> {
  const result = await queryable.query<JournalEntryRow>(
    `
      SELECT ${journalEntrySelectColumns}
      FROM journal_entries
      WHERE operator_id = $1 AND id = $2
      LIMIT 1
    `,
    [operatorId, entryId]
  );

  return result.rows[0] ? toJournalEntry(result.rows[0]) : null;
}

function toEngineTransaction(row: TransactionRow): EngineTransaction {
  return {
    id: row.id,
    operatorId: row.operator_id,
    record: row.canonical_record
  };
}

function toMappingRule(row: MappingRuleRow): MappingRule {
  return {
    id: row.id,
    operatorId: row.operator_id,
    productLine: row.product_line,
    biller: row.biller ?? undefined,
    billerCategory: row.biller_category ?? undefined,
    transactionType: row.transaction_type ?? undefined,
    ruleType: row.rule_type,
    entries: parseEntries(row.entries),
    status: row.status,
    version: row.version,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function parseEntries(value: unknown): JournalEntryTemplate[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const e = item as { label?: string; debitAccountCode: string; creditSplits: Array<{ accountCode: string; percentageBps: number }> };
    return {
      label: e.label,
      debitAccountCode: e.debitAccountCode,
      creditSplits: (e.creditSplits ?? []).map((s) => ({
        accountCode: s.accountCode,
        percentageBps: s.percentageBps
      }))
    };
  });
}

function toJournalEntry(row: JournalEntryRow): JournalEntry {
  return {
    id: row.id,
    operatorId: row.operator_id,
    transactionId: row.transaction_id,
    entryType: row.entry_type,
    status: row.status,
    currency: row.currency,
    amount: Number(row.amount),
    mappingRuleId: row.mapping_rule_id ?? undefined,
    mappingRuleVersion: row.mapping_rule_version ?? undefined,
    reversalOfJournalEntryId: row.reversal_of_journal_entry_id ?? undefined,
    entryOrder: row.entry_order,
    entryLabel: row.entry_label ?? undefined,
    generatedAt: toIsoString(row.generated_at),
    lines: parseJournalLines(row.lines)
  };
}

function parseJournalLines(value: unknown): JournalEntryLine[] {
  if (!Array.isArray(value)) return [];

  return value.map((line) => {
    const item = line as {
      accountCode: string;
      side: JournalLineSide;
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

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
