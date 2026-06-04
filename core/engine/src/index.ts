import { randomUUID } from 'node:crypto';

import type { CanonicalTransaction } from '@ledgerise/canonical-types';
import type { MappingRule } from '@ledgerise/core-mapping';

export type JournalEntryType = 'standard' | 'reversal' | 'unmapped';
export type JournalEntryStatus = 'generated' | 'unmapped';
export type JournalLineSide = 'debit' | 'credit';

export interface EngineTransaction {
  id: string;
  operatorId: string;
  record: CanonicalTransaction;
}

export interface JournalEntryLine {
  accountCode: string;
  side: JournalLineSide;
  amount: number;
  currency: string;
  lineOrder: number;
}

export interface JournalEntry {
  id: string;
  operatorId: string;
  transactionId: string;
  entryType: JournalEntryType;
  status: JournalEntryStatus;
  currency: string;
  amount: number;
  mappingRuleId?: string;
  mappingRuleVersion?: number;
  reversalOfJournalEntryId?: string;
  entryOrder: number;
  entryLabel?: string;
  generatedAt: string;
  lines: JournalEntryLine[];
}

export interface NewJournalEntry {
  operatorId: string;
  transactionId: string;
  entryType: JournalEntryType;
  status: JournalEntryStatus;
  currency: string;
  amount: number;
  mappingRuleId?: string;
  mappingRuleVersion?: number;
  reversalOfJournalEntryId?: string;
  entryOrder: number;
  entryLabel?: string;
  generatedAt: string;
  lines: JournalEntryLine[];
}

export interface JournalEngineRepository {
  listEligibleTransactions(input: {
    operatorId: string;
    limit: number;
  }): Promise<EngineTransaction[]>;
  listActiveMappingRules(operatorId: string): Promise<MappingRule[]>;
  findJournalEntryByTransactionId(input: {
    operatorId: string;
    transactionId: string;
  }): Promise<JournalEntry | null>;
  findJournalEntriesForTransaction(input: {
    operatorId: string;
    transactionId: string;
  }): Promise<JournalEntry[]>;
  saveJournalEntries(inputs: NewJournalEntry[]): Promise<JournalEntry[]>;
}

export interface JournalEngineOptions {
  suspenseAccountCode?: string;
  now?: () => string;
}

export interface JournalEngineRunInput {
  operatorId: string;
  limit?: number;
  suspenseAccountCode?: string;
}

export interface JournalEngineRunResult {
  scanned: number;
  generated: number;
  skipped: EngineSkip[];
  entries: JournalEntry[];
}

export interface EngineSkip {
  transactionId: string;
  reason: 'already_journaled' | 'ineligible' | 'reversal_original_missing';
}

type ResolvedMapping =
  | {
      status: 'matched';
      rule: MappingRule;
    }
  | {
      status: 'unmapped';
    };

interface MappingCandidate {
  rule: MappingRule;
  priority: 1 | 2 | 3;
  transactionTypeSpecificity: 0 | 1;
}

export class JournalEngineService {
  private readonly suspenseAccountCode: string;
  private readonly now: () => string;

  constructor(
    private readonly repository: JournalEngineRepository,
    options: JournalEngineOptions = {}
  ) {
    this.suspenseAccountCode = options.suspenseAccountCode ?? '9999';
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async runOnce(input: JournalEngineRunInput): Promise<JournalEngineRunResult> {
    const limit = input.limit ?? 100;
    const suspenseAccountCode = input.suspenseAccountCode ?? this.suspenseAccountCode;
    const transactions = await this.repository.listEligibleTransactions({
      operatorId: input.operatorId,
      limit
    });
    const rules = await this.repository.listActiveMappingRules(input.operatorId);
    const entries: JournalEntry[] = [];
    const skipped: EngineSkip[] = [];

    for (const transaction of transactions) {
      const existing = await this.repository.findJournalEntryByTransactionId({
        operatorId: transaction.operatorId,
        transactionId: transaction.id
      });

      if (existing) {
        skipped.push({ transactionId: transaction.id, reason: 'already_journaled' });
        continue;
      }

      if (!isEligibleForJournal(transaction.record)) {
        skipped.push({ transactionId: transaction.id, reason: 'ineligible' });
        continue;
      }

      const entryInputs =
        transaction.record.status === 'reversed'
          ? await this.buildReversalEntries(transaction)
          : this.buildStandardEntries(transaction, resolveMapping(transaction.record, rules), suspenseAccountCode);

      if (!entryInputs) {
        skipped.push({ transactionId: transaction.id, reason: 'reversal_original_missing' });
        continue;
      }

      for (const entryInput of entryInputs) {
        assertBalanced(entryInput.lines);
      }

      const saved = await this.repository.saveJournalEntries(entryInputs);
      entries.push(...saved);
    }

    return {
      scanned: transactions.length,
      generated: entries.length,
      skipped,
      entries
    };
  }

  private buildStandardEntries(
    transaction: EngineTransaction,
    mapping: ResolvedMapping,
    suspenseAccountCode: string
  ): NewJournalEntry[] {
    const record = transaction.record;

    if (mapping.status === 'unmapped') {
      return [{
        operatorId: transaction.operatorId,
        transactionId: transaction.id,
        entryType: 'unmapped',
        status: 'unmapped',
        currency: record.currency,
        amount: record.amount,
        entryOrder: 1,
        generatedAt: this.now(),
        lines: [
          {
            accountCode: suspenseAccountCode,
            side: 'debit',
            amount: record.amount,
            currency: record.currency,
            lineOrder: 1
          },
          {
            accountCode: suspenseAccountCode,
            side: 'credit',
            amount: record.amount,
            currency: record.currency,
            lineOrder: 2
          }
        ]
      }];
    }

    return mapping.rule.entries.map((entry, index) => ({
      operatorId: transaction.operatorId,
      transactionId: transaction.id,
      entryType: 'standard' as const,
      status: 'generated' as const,
      currency: record.currency,
      amount: record.amount,
      mappingRuleId: mapping.rule.id,
      mappingRuleVersion: mapping.rule.version,
      entryOrder: index + 1,
      entryLabel: entry.label,
      generatedAt: this.now(),
      lines: [
        {
          accountCode: entry.debitAccountCode,
          side: 'debit' as const,
          amount: record.amount,
          currency: record.currency,
          lineOrder: 1
        },
        ...allocateCreditSplits(entry, record.amount, record.currency, 2)
      ]
    }));
  }

  private async buildReversalEntries(
    transaction: EngineTransaction
  ): Promise<NewJournalEntry[] | null> {
    const originalTransactionId = transaction.record.reversal_of;
    if (!originalTransactionId) return null;

    const originalEntries = await this.repository.findJournalEntriesForTransaction({
      operatorId: transaction.operatorId,
      transactionId: originalTransactionId
    });

    if (originalEntries.length === 0) return null;

    return originalEntries.map((original) => ({
      operatorId: transaction.operatorId,
      transactionId: transaction.id,
      entryType: 'reversal' as const,
      status: 'generated' as const,
      currency: transaction.record.currency,
      amount: original.amount,
      reversalOfJournalEntryId: original.id,
      entryOrder: original.entryOrder,
      entryLabel: original.entryLabel,
      generatedAt: this.now(),
      lines: original.lines.map((line, index) => ({
        accountCode: line.accountCode,
        side: line.side === 'debit' ? 'credit' : 'debit' as const,
        amount: line.amount,
        currency: line.currency,
        lineOrder: index + 1
      }))
    }));
  }
}

export class InMemoryJournalEngineRepository implements JournalEngineRepository {
  readonly transactions: EngineTransaction[] = [];
  readonly rules: MappingRule[] = [];
  readonly entries: JournalEntry[] = [];

  async listEligibleTransactions(input: {
    operatorId: string;
    limit: number;
  }): Promise<EngineTransaction[]> {
    return this.transactions
      .filter((transaction) => transaction.operatorId === input.operatorId)
      .filter((transaction) => !this.entries.some((entry) => entry.transactionId === transaction.id))
      .slice(0, input.limit);
  }

  async listActiveMappingRules(operatorId: string): Promise<MappingRule[]> {
    return this.rules.filter((rule) => rule.operatorId === operatorId && rule.status === 'active');
  }

  async findJournalEntryByTransactionId(input: {
    operatorId: string;
    transactionId: string;
  }): Promise<JournalEntry | null> {
    return (
      this.entries.find(
        (entry) =>
          entry.operatorId === input.operatorId && entry.transactionId === input.transactionId
      ) ?? null
    );
  }

  async findJournalEntriesForTransaction(input: {
    operatorId: string;
    transactionId: string;
  }): Promise<JournalEntry[]> {
    return this.entries
      .filter((e) => e.operatorId === input.operatorId && e.transactionId === input.transactionId)
      .sort((a, b) => a.entryOrder - b.entryOrder);
  }

  async saveJournalEntries(inputs: NewJournalEntry[]): Promise<JournalEntry[]> {
    const saved: JournalEntry[] = [];
    for (const input of inputs) {
      const existing = this.entries.find(
        (e) => e.operatorId === input.operatorId &&
               e.transactionId === input.transactionId &&
               e.entryOrder === input.entryOrder
      );
      if (existing) {
        saved.push(existing);
        continue;
      }
      const entry: JournalEntry = { id: randomUUID(), ...input };
      this.entries.push(entry);
      saved.push(entry);
    }
    return saved;
  }
}

export function isEligibleForJournal(record: CanonicalTransaction): boolean {
  const environment = record.source.environment ?? 'live';
  if (environment === 'test') return false;

  if (record.status === 'settled') {
    return record.settled_at !== null;
  }

  return record.status === 'reversed';
}

export function resolveMapping(
  record: CanonicalTransaction,
  rules: MappingRule[]
): ResolvedMapping {
  const candidates: MappingCandidate[] = [];

  for (const rule of rules) {
    if (rule.status !== 'active') continue;
    if (rule.productLine.toLowerCase() !== record.product.line.toLowerCase()) continue;
    if (rule.transactionType && rule.transactionType.toLowerCase() !== record.type.toLowerCase()) continue;

    const priority = mappingPriority(rule, record);
    if (priority === null) continue;

    candidates.push({
      rule,
      priority,
      transactionTypeSpecificity: rule.transactionType ? 0 : 1
    });
  }

  candidates
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      if (left.transactionTypeSpecificity !== right.transactionTypeSpecificity) {
        return left.transactionTypeSpecificity - right.transactionTypeSpecificity;
      }
      return left.rule.createdAt.localeCompare(right.rule.createdAt);
    });

  const best = candidates[0];
  return best ? { status: 'matched', rule: best.rule } : { status: 'unmapped' };
}

function mappingPriority(rule: MappingRule, record: CanonicalTransaction): 1 | 2 | 3 | null {
  if (rule.biller) return rule.biller.toLowerCase() === record.product.biller?.toLowerCase() ? 1 : null;
  if (rule.billerCategory) {
    return rule.billerCategory.toLowerCase() === record.product.biller_category?.toLowerCase() ? 2 : null;
  }
  return 3;
}

function allocateCreditSplits(
  entry: { creditSplits: Array<{ accountCode: string; percentageBps: number }> },
  amount: number,
  currency: string,
  firstLineOrder: number
): JournalEntryLine[] {
  let allocated = 0;

  return entry.creditSplits.map((split, index) => {
    const isLast = index === entry.creditSplits.length - 1;
    const splitAmount = isLast
      ? amount - allocated
      : Math.floor((amount * split.percentageBps) / 10000);
    allocated += splitAmount;

    return {
      accountCode: split.accountCode,
      side: 'credit',
      amount: splitAmount,
      currency,
      lineOrder: firstLineOrder + index
    };
  });
}

function assertBalanced(lines: JournalEntryLine[]): void {
  const debit = lines
    .filter((line) => line.side === 'debit')
    .reduce((sum, line) => sum + line.amount, 0);
  const credit = lines
    .filter((line) => line.side === 'credit')
    .reduce((sum, line) => sum + line.amount, 0);

  if (debit !== credit) {
    throw new Error(`Journal entry is not balanced. Debit ${debit}, credit ${credit}.`);
  }
}
