import { randomUUID } from 'node:crypto';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type MappingRuleStatus = 'active' | 'inactive';

export interface ChartAccount {
  id: string;
  operatorId: string;
  code: string;
  name: string;
  type: AccountType;
  subCategory?: string;
  currency: string;
  parentCode?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreditSplit {
  accountCode: string;
  percentageBps: number;
}

export interface JournalEntryTemplate {
  label?: string;
  debitAccountCode: string;
  creditSplits: CreditSplit[];
}

export interface MappingRule {
  id: string;
  operatorId: string;
  productLine: string;
  biller?: string;
  billerCategory?: string;
  transactionType?: string;
  ruleType: 'simple' | 'compound';
  entries: JournalEntryTemplate[];
  status: MappingRuleStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewChartAccount {
  code: string;
  name: string;
  type: AccountType;
  subCategory?: string;
  currency?: string;
  parentCode?: string;
  active?: boolean;
}

export interface NewMappingRule {
  productLine: string;
  biller?: string;
  billerCategory?: string;
  transactionType?: string;
  ruleType?: 'simple' | 'compound';
  entries: JournalEntryTemplate[];
  status?: MappingRuleStatus;
}

export interface UpdateMappingRule {
  productLine?: string;
  biller?: string | null;
  billerCategory?: string | null;
  transactionType?: string | null;
  ruleType?: 'simple' | 'compound';
  entries?: JournalEntryTemplate[];
}

export interface MappingRepository {
  importChartAccounts(operatorId: string, accounts: NewChartAccount[]): Promise<ChartAccount[]>;
  listChartAccounts(operatorId: string): Promise<ChartAccount[]>;
  updateChartAccount(operatorId: string, code: string, patch: { active: boolean }): Promise<ChartAccount | null>;
  deleteChartAccount(operatorId: string, code: string): Promise<boolean>;
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

  updateChartAccount(operatorId: string, code: string, patch: { active: boolean }): Promise<ChartAccount | null> {
    return this.repository.updateChartAccount(operatorId, code, patch);
  }

  deleteChartAccount(operatorId: string, code: string): Promise<boolean> {
    return this.repository.deleteChartAccount(operatorId, code);
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
      ruleType: input.ruleType ?? existing.ruleType,
      entries: input.entries ?? existing.entries,
      status: existing.status
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
        existing.subCategory = account.subCategory ?? existing.subCategory;
        existing.currency = account.currency ?? existing.currency;
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
        subCategory: account.subCategory,
        currency: account.currency ?? 'NGN',
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

  async updateChartAccount(operatorId: string, code: string, patch: { active: boolean }): Promise<ChartAccount | null> {
    const account = this.accounts.find((a) => a.operatorId === operatorId && a.code === code);
    if (!account) return null;
    account.active = patch.active;
    account.updatedAt = new Date().toISOString();
    return account;
  }

  async deleteChartAccount(operatorId: string, code: string): Promise<boolean> {
    const index = this.accounts.findIndex((a) => a.operatorId === operatorId && a.code === code);
    if (index === -1) return false;
    this.accounts.splice(index, 1);
    return true;
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
      ruleType: input.ruleType ?? 'simple',
      entries: input.entries,
      status: input.status ?? 'active',
      version: 1,
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
    rule.ruleType = input.ruleType ?? rule.ruleType;
    rule.entries = input.entries ?? rule.entries;
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
  if (!input.entries || input.entries.length === 0) errors.push('entries is required');

  for (const [ei, entry] of (input.entries ?? []).entries()) {
    const prefix = `entries.${ei}`;
    if (!entry.debitAccountCode) errors.push(`${prefix}.debitAccountCode is required`);
    if (!entry.creditSplits || entry.creditSplits.length === 0) {
      errors.push(`${prefix}.creditSplits is required`);
    }

    const total = entry.creditSplits?.reduce((sum, split) => sum + split.percentageBps, 0) ?? 0;
    if (total !== 10000) errors.push(`${prefix}.creditSplits must sum to 10000 basis points`);

    for (const [si, split] of (entry.creditSplits ?? []).entries()) {
      if (!split.accountCode) errors.push(`${prefix}.creditSplits.${si}.accountCode is required`);
      if (!Number.isInteger(split.percentageBps) || split.percentageBps <= 0) {
        errors.push(`${prefix}.creditSplits.${si}.percentageBps must be a positive integer`);
      }
    }
  }

  if (errors.length > 0) throw new MappingValidationError(errors);
}
