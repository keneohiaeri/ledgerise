import { randomUUID } from 'node:crypto';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type MappingRuleStatus = 'active' | 'inactive';

export interface ChartAccount {
  id: string;
  operatorId: string;
  code: string;
  name: string;
  type: AccountType;
  parentCode?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreditSplit {
  accountCode: string;
  percentageBps: number;
}

export interface MappingRule {
  id: string;
  operatorId: string;
  productLine: string;
  biller?: string;
  billerCategory?: string;
  transactionType?: string;
  debitAccountCode: string;
  status: MappingRuleStatus;
  version: number;
  creditSplits: CreditSplit[];
  createdAt: string;
  updatedAt: string;
}

export interface NewChartAccount {
  code: string;
  name: string;
  type: AccountType;
  parentCode?: string;
  active?: boolean;
}

export interface NewMappingRule {
  productLine: string;
  biller?: string;
  billerCategory?: string;
  transactionType?: string;
  debitAccountCode: string;
  status?: MappingRuleStatus;
  creditSplits: CreditSplit[];
}

export interface UpdateMappingRule {
  productLine?: string;
  biller?: string | null;
  billerCategory?: string | null;
  transactionType?: string | null;
  debitAccountCode?: string;
  creditSplits?: CreditSplit[];
}

export interface MappingRepository {
  importChartAccounts(operatorId: string, accounts: NewChartAccount[]): Promise<ChartAccount[]>;
  listChartAccounts(operatorId: string): Promise<ChartAccount[]>;
  createMappingRule(operatorId: string, input: NewMappingRule): Promise<MappingRule>;
  updateMappingRule(operatorId: string, ruleId: string, input: UpdateMappingRule): Promise<MappingRule | null>;
  setMappingRuleStatus(
    operatorId: string,
    ruleId: string,
    status: MappingRuleStatus
  ): Promise<MappingRule | null>;
  listMappingRules(operatorId: string): Promise<MappingRule[]>;
  findMappingRuleById(operatorId: string, ruleId: string): Promise<MappingRule | null>;
}

export class MappingValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super('Mapping validation failed');
    this.name = 'MappingValidationError';
    this.errors = errors;
  }
}

export class MappingService {
  constructor(private readonly repository: MappingRepository) {}

  importChartAccounts(operatorId: string, accounts: NewChartAccount[]): Promise<ChartAccount[]> {
    const errors = accounts.flatMap((account, index) => validateChartAccount(account, index));
    if (errors.length > 0) throw new MappingValidationError(errors);
    return this.repository.importChartAccounts(operatorId, accounts);
  }

  listChartAccounts(operatorId: string): Promise<ChartAccount[]> {
    return this.repository.listChartAccounts(operatorId);
  }

  createMappingRule(operatorId: string, input: NewMappingRule): Promise<MappingRule> {
    validateMappingRule(input);
    return this.repository.createMappingRule(operatorId, input);
  }

  async updateMappingRule(
    operatorId: string,
    ruleId: string,
    input: UpdateMappingRule
  ): Promise<MappingRule | null> {
    const existing = await this.repository.findMappingRuleById(operatorId, ruleId);
    if (!existing) return null;

    validateMappingRule({
      productLine: input.productLine ?? existing.productLine,
      biller: input.biller === null ? undefined : input.biller ?? existing.biller,
      billerCategory:
        input.billerCategory === null ? undefined : input.billerCategory ?? existing.billerCategory,
      transactionType:
        input.transactionType === null ? undefined : input.transactionType ?? existing.transactionType,
      debitAccountCode: input.debitAccountCode ?? existing.debitAccountCode,
      status: existing.status,
      creditSplits: input.creditSplits ?? existing.creditSplits
    });

    return this.repository.updateMappingRule(operatorId, ruleId, input);
  }

  setMappingRuleStatus(
    operatorId: string,
    ruleId: string,
    status: MappingRuleStatus
  ): Promise<MappingRule | null> {
    return this.repository.setMappingRuleStatus(operatorId, ruleId, status);
  }

  listMappingRules(operatorId: string): Promise<MappingRule[]> {
    return this.repository.listMappingRules(operatorId);
  }
}

export class InMemoryMappingRepository implements MappingRepository {
  readonly accounts: ChartAccount[] = [];
  readonly rules: MappingRule[] = [];

  async importChartAccounts(operatorId: string, accounts: NewChartAccount[]): Promise<ChartAccount[]> {
    const now = new Date().toISOString();
    const imported = accounts.map((account) => {
      const existing = this.accounts.find((item) => item.operatorId === operatorId && item.code === account.code);
      if (existing) {
        existing.name = account.name;
        existing.type = account.type;
        existing.parentCode = account.parentCode;
        existing.active = account.active ?? true;
        existing.updatedAt = now;
        return existing;
      }

      const created: ChartAccount = {
        id: randomUUID(),
        operatorId,
        code: account.code,
        name: account.name,
        type: account.type,
        parentCode: account.parentCode,
        active: account.active ?? true,
        createdAt: now,
        updatedAt: now
      };
      this.accounts.push(created);
      return created;
    });

    return imported;
  }

  async listChartAccounts(operatorId: string): Promise<ChartAccount[]> {
    return this.accounts.filter((account) => account.operatorId === operatorId);
  }

  async createMappingRule(operatorId: string, input: NewMappingRule): Promise<MappingRule> {
    const now = new Date().toISOString();
    const rule: MappingRule = {
      id: randomUUID(),
      operatorId,
      productLine: input.productLine,
      biller: input.biller,
      billerCategory: input.billerCategory,
      transactionType: input.transactionType,
      debitAccountCode: input.debitAccountCode,
      status: input.status ?? 'active',
      version: 1,
      creditSplits: input.creditSplits,
      createdAt: now,
      updatedAt: now
    };
    this.rules.push(rule);
    return rule;
  }

  async updateMappingRule(operatorId: string, ruleId: string, input: UpdateMappingRule): Promise<MappingRule | null> {
    const rule = await this.findMappingRuleById(operatorId, ruleId);
    if (!rule) return null;

    rule.productLine = input.productLine ?? rule.productLine;
    rule.biller = input.biller === null ? undefined : input.biller ?? rule.biller;
    rule.billerCategory =
      input.billerCategory === null ? undefined : input.billerCategory ?? rule.billerCategory;
    rule.transactionType =
      input.transactionType === null ? undefined : input.transactionType ?? rule.transactionType;
    rule.debitAccountCode = input.debitAccountCode ?? rule.debitAccountCode;
    rule.creditSplits = input.creditSplits ?? rule.creditSplits;
    rule.version += 1;
    rule.updatedAt = new Date().toISOString();
    return rule;
  }

  async setMappingRuleStatus(
    operatorId: string,
    ruleId: string,
    status: MappingRuleStatus
  ): Promise<MappingRule | null> {
    const rule = await this.findMappingRuleById(operatorId, ruleId);
    if (!rule) return null;
    rule.status = status;
    rule.version += 1;
    rule.updatedAt = new Date().toISOString();
    return rule;
  }

  async listMappingRules(operatorId: string): Promise<MappingRule[]> {
    return this.rules.filter((rule) => rule.operatorId === operatorId);
  }

  async findMappingRuleById(operatorId: string, ruleId: string): Promise<MappingRule | null> {
    return this.rules.find((rule) => rule.operatorId === operatorId && rule.id === ruleId) ?? null;
  }
}

function validateChartAccount(account: NewChartAccount, index: number): string[] {
  const prefix = `accounts.${index}`;
  const errors: string[] = [];
  if (!account.code) errors.push(`${prefix}.code is required`);
  if (!account.name) errors.push(`${prefix}.name is required`);
  if (!['asset', 'liability', 'equity', 'revenue', 'expense'].includes(account.type)) {
    errors.push(`${prefix}.type is invalid`);
  }
  return errors;
}

function validateMappingRule(input: NewMappingRule): void {
  const errors: string[] = [];
  if (!input.productLine) errors.push('productLine is required');
  if (!input.debitAccountCode) errors.push('debitAccountCode is required');
  if (!input.creditSplits || input.creditSplits.length === 0) errors.push('creditSplits is required');

  const total = input.creditSplits?.reduce((sum, split) => sum + split.percentageBps, 0) ?? 0;
  if (total !== 10000) errors.push('creditSplits must sum to 10000 basis points');

  for (const [index, split] of (input.creditSplits ?? []).entries()) {
    if (!split.accountCode) errors.push(`creditSplits.${index}.accountCode is required`);
    if (!Number.isInteger(split.percentageBps) || split.percentageBps <= 0) {
      errors.push(`creditSplits.${index}.percentageBps must be a positive integer`);
    }
  }

  if (errors.length > 0) throw new MappingValidationError(errors);
}
