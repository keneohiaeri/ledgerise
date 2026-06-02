import pg from 'pg';

import {
  type ChartAccount,
  type JournalEntryTemplate,
  type MappingRepository,
  type MappingRule,
  type MappingRuleStatus,
  type NewChartAccount,
  type NewMappingRule,
  type UpdateMappingRule
} from './index.js';

const { Pool } = pg;

export interface PostgresMappingRepositoryOptions {
  connectionString: string;
  max?: number;
}

interface ChartAccountRow {
  id: string;
  operator_id: string;
  code: string;
  name: string;
  type: ChartAccount['type'];
  sub_category: string | null;
  currency: string;
  parent_code: string | null;
  active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
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

export class PostgresMappingRepository implements MappingRepository {
  private readonly pool: pg.Pool;

  constructor(options: PostgresMappingRepositoryOptions | pg.Pool) {
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

  async importChartAccounts(operatorId: string, accounts: NewChartAccount[]): Promise<ChartAccount[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Deactivate all existing accounts not present in the import — full replacement behaviour
      const incomingCodes = accounts.map((a) => a.code);
      if (incomingCodes.length > 0) {
        await client.query(
          `UPDATE chart_of_accounts SET active = false, updated_at = now()
           WHERE operator_id = $1 AND code != ALL($2::text[])`,
          [operatorId, incomingCodes]
        );
      }

      const imported: ChartAccount[] = [];
      for (const account of accounts) {
        const result = await client.query<ChartAccountRow>(
          `
            INSERT INTO chart_of_accounts (operator_id, code, name, type, sub_category, currency, parent_code, active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (operator_id, code) DO UPDATE SET
              name        = EXCLUDED.name,
              type        = EXCLUDED.type,
              sub_category = EXCLUDED.sub_category,
              currency    = EXCLUDED.currency,
              parent_code = EXCLUDED.parent_code,
              active      = EXCLUDED.active,
              updated_at  = now()
            RETURNING id, operator_id, code, name, type, sub_category, currency, parent_code, active, created_at, updated_at
          `,
          [
            operatorId, account.code, account.name, account.type,
            account.subCategory ?? null, account.currency ?? 'NGN',
            account.parentCode ?? null, account.active ?? true
          ]
        );
        if (result.rows[0]) imported.push(toChartAccount(result.rows[0]));
      }
      await client.query('COMMIT');
      return imported;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listChartAccounts(operatorId: string): Promise<ChartAccount[]> {
    const result = await this.pool.query<ChartAccountRow>(
      `
        SELECT id, operator_id, code, name, type, sub_category, currency, parent_code, active, created_at, updated_at
        FROM chart_of_accounts
        WHERE operator_id = $1
        ORDER BY code ASC
      `,
      [operatorId]
    );
    return result.rows.map(toChartAccount);
  }

  async updateChartAccount(operatorId: string, code: string, patch: { active: boolean }): Promise<ChartAccount | null> {
    const result = await this.pool.query<ChartAccountRow>(
      `
        UPDATE chart_of_accounts
        SET active = $3, updated_at = now()
        WHERE operator_id = $1 AND code = $2
        RETURNING id, operator_id, code, name, type, sub_category, currency, parent_code, active, created_at, updated_at
      `,
      [operatorId, code, patch.active]
    );
    return result.rows[0] ? toChartAccount(result.rows[0]) : null;
  }

  async deleteChartAccount(operatorId: string, code: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM chart_of_accounts WHERE operator_id = $1 AND code = $2`,
      [operatorId, code]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createMappingRule(operatorId: string, input: NewMappingRule): Promise<MappingRule> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ruleResult = await client.query<MappingRuleRow>(
        `
          INSERT INTO mapping_rules (
            operator_id, product_line, biller, biller_category, transaction_type,
            rule_type, entries, status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING ${mappingRuleSelectColumns}
        `,
        [
          operatorId,
          input.productLine,
          input.biller ?? null,
          input.billerCategory ?? null,
          input.transactionType ?? null,
          input.ruleType ?? 'simple',
          JSON.stringify(input.entries),
          input.status ?? 'active'
        ]
      );
      const rule = ruleResult.rows[0] ? toMappingRule(ruleResult.rows[0]) : null;
      if (!rule) throw new Error('Failed to create mapping rule');
      await recordVersionAndAudit(client, rule, 'mapping_rule.created', null, rule);
      await client.query('COMMIT');
      return rule;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateMappingRule(operatorId: string, ruleId: string, input: UpdateMappingRule): Promise<MappingRule | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const before = await findRuleById(client, operatorId, ruleId);
      if (!before) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(
        `
          UPDATE mapping_rules SET
            product_line    = COALESCE($3, product_line),
            biller          = CASE WHEN $4 THEN NULL ELSE COALESCE($5, biller) END,
            biller_category = CASE WHEN $6 THEN NULL ELSE COALESCE($7, biller_category) END,
            transaction_type = CASE WHEN $8 THEN NULL ELSE COALESCE($9, transaction_type) END,
            rule_type       = COALESCE($10, rule_type),
            entries         = COALESCE($11, entries),
            version         = version + 1,
            updated_at      = now()
          WHERE operator_id = $1 AND id = $2
        `,
        [
          operatorId,
          ruleId,
          input.productLine ?? null,
          input.biller === null,
          input.biller ?? null,
          input.billerCategory === null,
          input.billerCategory ?? null,
          input.transactionType === null,
          input.transactionType ?? null,
          input.ruleType ?? null,
          input.entries ? JSON.stringify(input.entries) : null
        ]
      );
      const after = await findRuleById(client, operatorId, ruleId);
      if (!after) throw new Error('Failed to reload mapping rule');
      await recordVersionAndAudit(client, after, 'mapping_rule.updated', before, after);
      await client.query('COMMIT');
      return after;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async setMappingRuleStatus(
    operatorId: string,
    ruleId: string,
    status: MappingRuleStatus
  ): Promise<MappingRule | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const before = await findRuleById(client, operatorId, ruleId);
      if (!before) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(
        `
          UPDATE mapping_rules
          SET status = $3, version = version + 1, updated_at = now()
          WHERE operator_id = $1 AND id = $2
        `,
        [operatorId, ruleId, status]
      );
      const after = await findRuleById(client, operatorId, ruleId);
      if (!after) throw new Error('Failed to reload mapping rule');
      await recordVersionAndAudit(client, after, `mapping_rule.${status}`, before, after);
      await client.query('COMMIT');
      return after;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listMappingRules(operatorId: string): Promise<MappingRule[]> {
    const result = await this.pool.query<MappingRuleRow>(
      `
        SELECT ${mappingRuleSelectColumns}
        FROM mapping_rules
        WHERE operator_id = $1
        ORDER BY product_line ASC, biller ASC NULLS LAST, biller_category ASC NULLS LAST
      `,
      [operatorId]
    );
    return result.rows.map(toMappingRule);
  }

  async findMappingRuleById(operatorId: string, ruleId: string): Promise<MappingRule | null> {
    return findRuleById(this.pool, operatorId, ruleId);
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

async function findRuleById(
  queryable: pg.Pool | pg.PoolClient,
  operatorId: string,
  ruleId: string
): Promise<MappingRule | null> {
  const result = await queryable.query<MappingRuleRow>(
    `
      SELECT ${mappingRuleSelectColumns}
      FROM mapping_rules
      WHERE operator_id = $1 AND id = $2
      LIMIT 1
    `,
    [operatorId, ruleId]
  );
  return result.rows[0] ? toMappingRule(result.rows[0]) : null;
}

async function recordVersionAndAudit(
  client: pg.PoolClient,
  rule: MappingRule,
  eventType: string,
  before: MappingRule | null,
  after: MappingRule
) {
  await client.query(
    `
      INSERT INTO mapping_rule_versions (mapping_rule_id, operator_id, version, snapshot)
      VALUES ($1, $2, $3, $4)
    `,
    [rule.id, rule.operatorId, rule.version, JSON.stringify(after)]
  );
  await client.query(
    `
      INSERT INTO audit_events (
        operator_id, event_type, entity_type, entity_id, before_state, after_state
      )
      VALUES ($1, $2, 'mapping_rule', $3, $4, $5)
    `,
    [rule.operatorId, eventType, rule.id, before ? JSON.stringify(before) : null, JSON.stringify(after)]
  );
}

function toChartAccount(row: ChartAccountRow): ChartAccount {
  return {
    id: row.id,
    operatorId: row.operator_id,
    code: row.code,
    name: row.name,
    type: row.type,
    subCategory: row.sub_category ?? undefined,
    currency: row.currency,
    parentCode: row.parent_code ?? undefined,
    active: row.active,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
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

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
