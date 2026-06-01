import pg from 'pg';

import {
  type ChartAccount,
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
  debit_account_code: string;
  status: MappingRuleStatus;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  credit_splits: unknown;
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

  async importChartAccounts(operatorId: string, accounts: NewChartAccount[]): Promise<ChartAccount[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const imported: ChartAccount[] = [];
      for (const account of accounts) {
        const result = await client.query<ChartAccountRow>(
          `
            INSERT INTO chart_of_accounts (operator_id, code, name, type, parent_code, active)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (operator_id, code) DO UPDATE SET
              name = EXCLUDED.name,
              type = EXCLUDED.type,
              parent_code = EXCLUDED.parent_code,
              active = EXCLUDED.active,
              updated_at = now()
            RETURNING id, operator_id, code, name, type, parent_code, active, created_at, updated_at
          `,
          [operatorId, account.code, account.name, account.type, account.parentCode ?? null, account.active ?? true]
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
        SELECT id, operator_id, code, name, type, parent_code, active, created_at, updated_at
        FROM chart_of_accounts
        WHERE operator_id = $1
        ORDER BY code ASC
      `,
      [operatorId]
    );
    return result.rows.map(toChartAccount);
  }

  async createMappingRule(operatorId: string, input: NewMappingRule): Promise<MappingRule> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ruleResult = await client.query<MappingRuleRow>(
        `
          INSERT INTO mapping_rules (
            operator_id, product_line, biller, biller_category, transaction_type,
            debit_account_code, status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING ${mappingRuleSelectColumns}
        `,
        [
          operatorId,
          input.productLine,
          input.biller ?? null,
          input.billerCategory ?? null,
          input.transactionType ?? null,
          input.debitAccountCode,
          input.status ?? 'active'
        ]
      );
      const base = ruleResult.rows[0];
      if (!base) throw new Error('Failed to create mapping rule');
      await replaceCreditSplits(client, operatorId, base.id, input.creditSplits);
      const rule = await findRuleById(client, operatorId, base.id);
      if (!rule) throw new Error('Failed to reload mapping rule');
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
            product_line = COALESCE($3, product_line),
            biller = CASE WHEN $4 THEN NULL ELSE COALESCE($5, biller) END,
            biller_category = CASE WHEN $6 THEN NULL ELSE COALESCE($7, biller_category) END,
            transaction_type = CASE WHEN $8 THEN NULL ELSE COALESCE($9, transaction_type) END,
            debit_account_code = COALESCE($10, debit_account_code),
            version = version + 1,
            updated_at = now()
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
          input.debitAccountCode ?? null
        ]
      );
      if (input.creditSplits) await replaceCreditSplits(client, operatorId, ruleId, input.creditSplits);
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
  debit_account_code,
  status,
  version,
  created_at,
  updated_at,
  (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'accountCode', account_code,
          'percentageBps', percentage_bps
        )
        ORDER BY account_code
      ),
      '[]'::jsonb
    )
    FROM mapping_rule_credit_splits
    WHERE mapping_rule_credit_splits.mapping_rule_id = mapping_rules.id
  ) AS credit_splits
`;

async function replaceCreditSplits(
  client: pg.PoolClient,
  operatorId: string,
  ruleId: string,
  splits: NewMappingRule['creditSplits']
) {
  await client.query('DELETE FROM mapping_rule_credit_splits WHERE mapping_rule_id = $1', [ruleId]);
  for (const split of splits) {
    await client.query(
      `
        INSERT INTO mapping_rule_credit_splits (
          mapping_rule_id, operator_id, account_code, percentage_bps
        )
        VALUES ($1, $2, $3, $4)
      `,
      [ruleId, operatorId, split.accountCode, split.percentageBps]
    );
  }
}

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
    debitAccountCode: row.debit_account_code,
    status: row.status,
    version: row.version,
    creditSplits: Array.isArray(row.credit_splits)
      ? row.credit_splits.map((split) => {
          const item = split as { accountCode: string; percentageBps: number };
          return { accountCode: item.accountCode, percentageBps: item.percentageBps };
        })
      : [],
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
