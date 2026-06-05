import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  InMemoryJournalEngineRepository,
  JournalEngineService,
  isEligibleForJournal,
  resolveMapping,
} from '@ledgerise/core-engine';

// ── helpers ───────────────────────────────────────────────────────────────────

function tx(overrides = {}) {
  return {
    id: randomUUID(),
    source: { adapter: 'adapter-a', system: 'system-a', environment: 'live' },
    occurred_at: '2024-01-01T00:00:00.000Z',
    settled_at: '2024-01-01T00:01:00.000Z',
    status: 'settled',
    type: 'payment.airtime',
    direction: 'debit',
    amount: 10000,
    currency: 'NGN',
    principal: { id: 'principal-a' },
    channel: 'web',
    product: { line: 'line-a', biller: 'biller-a', biller_category: 'cat-a' },
    metadata: {},
    ...overrides,
  };
}

function rule(overrides = {}) {
  return {
    id: randomUUID(),
    operatorId: 'op-a',
    productLine: 'line-a',
    ruleType: 'simple',
    entries: [{
      debitAccountCode: '1000',
      creditSplits: [{ accountCode: '4000', percentageBps: 10000 }],
    }],
    status: 'active',
    version: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function setup(transactions = [], rules = []) {
  const repo = new InMemoryJournalEngineRepository();
  for (const t of transactions) {
    repo.transactions.push({ id: t.id, operatorId: 'op-a', record: t });
  }
  for (const r of rules) {
    repo.rules.push(r);
  }
  const engine = new JournalEngineService(repo, {
    now: () => '2024-01-01T12:00:00.000Z',
    suspenseAccountCode: '9999',
  });
  return { repo, engine };
}

// ── isEligibleForJournal ──────────────────────────────────────────────────────

describe('isEligibleForJournal', () => {
  it('rejects test environment transactions', () => {
    assert.equal(
      isEligibleForJournal(tx({ source: { adapter: 'adapter-a', system: 'system-a', environment: 'test' } })),
      false
    );
  });

  it('accepts settled transactions with settled_at set', () => {
    assert.equal(
      isEligibleForJournal(tx({ status: 'settled', settled_at: '2024-01-01T00:01:00.000Z' })),
      true
    );
  });

  it('rejects settled transactions where settled_at is null', () => {
    assert.equal(
      isEligibleForJournal(tx({ status: 'settled', settled_at: null })),
      false
    );
  });

  it('rejects pending transactions', () => {
    assert.equal(isEligibleForJournal(tx({ status: 'pending', settled_at: null })), false);
  });

  it('rejects failed transactions', () => {
    assert.equal(isEligibleForJournal(tx({ status: 'failed', settled_at: null })), false);
  });

  it('accepts reversed transactions', () => {
    assert.equal(isEligibleForJournal(tx({ status: 'reversed', settled_at: null })), true);
  });
});

// ── resolveMapping ────────────────────────────────────────────────────────────

describe('resolveMapping', () => {
  it('exact biller match takes priority over biller category match', () => {
    const billerRule = rule({ id: 'biller-rule', biller: 'biller-a' });
    const categoryRule = rule({ id: 'category-rule', billerCategory: 'cat-a' });
    const result = resolveMapping(
      tx({ product: { line: 'line-a', biller: 'biller-a', biller_category: 'cat-a' } }),
      [categoryRule, billerRule]
    );
    assert.equal(result.status, 'matched');
    assert.equal(result.rule.id, 'biller-rule');
  });

  it('biller category match takes priority over product-line catch-all', () => {
    const categoryRule = rule({ id: 'category-rule', billerCategory: 'cat-a' });
    const catchAllRule = rule({ id: 'catchall-rule' });
    const result = resolveMapping(
      tx({ product: { line: 'line-a', biller: 'biller-b', biller_category: 'cat-a' } }),
      [catchAllRule, categoryRule]
    );
    assert.equal(result.status, 'matched');
    assert.equal(result.rule.id, 'category-rule');
  });

  it('product-line catch-all applies when no specific match exists', () => {
    const catchAllRule = rule({ id: 'catchall-rule' });
    const result = resolveMapping(
      tx({ product: { line: 'line-a', biller: 'biller-z', biller_category: 'cat-z' } }),
      [catchAllRule]
    );
    assert.equal(result.status, 'matched');
    assert.equal(result.rule.id, 'catchall-rule');
  });

  it('returns unmapped when no rule matches the product line', () => {
    const r = rule({ productLine: 'line-b' });
    const result = resolveMapping(
      tx({ product: { line: 'line-a' } }),
      [r]
    );
    assert.equal(result.status, 'unmapped');
  });

  it('ignores inactive rules', () => {
    const r = rule({ status: 'inactive' });
    const result = resolveMapping(tx(), [r]);
    assert.equal(result.status, 'unmapped');
  });

  it('typed rule wins over untyped rule at the same priority tier', () => {
    const typedRule = rule({ id: 'typed-rule', transactionType: 'payment.airtime' });
    const untypedRule = rule({ id: 'untyped-rule' });
    const result = resolveMapping(
      tx({ type: 'payment.airtime', product: { line: 'line-a' } }),
      [untypedRule, typedRule]
    );
    assert.equal(result.status, 'matched');
    assert.equal(result.rule.id, 'typed-rule');
  });

  it('excludes rules where transaction type does not match', () => {
    const r = rule({ transactionType: 'payment.data' });
    const result = resolveMapping(
      tx({ type: 'payment.airtime' }),
      [r]
    );
    assert.equal(result.status, 'unmapped');
  });
});

// ── credit split allocation ───────────────────────────────────────────────────

describe('credit split allocation', () => {
  it('single 100% split receives full transaction amount', async () => {
    const transaction = tx({ amount: 10000 });
    const r = rule({
      entries: [{ debitAccountCode: '1000', creditSplits: [{ accountCode: '4000', percentageBps: 10000 }] }],
    });
    const { engine } = setup([transaction], [r]);
    const result = await engine.runOnce({ operatorId: 'op-a', limit: 10 });
    const credits = result.entries[0].lines.filter(l => l.side === 'credit');
    assert.equal(credits.length, 1);
    assert.equal(credits[0].amount, 10000);
  });

  it('two equal 50/50 splits each receive half the amount', async () => {
    const transaction = tx({ amount: 10000 });
    const r = rule({
      entries: [{
        debitAccountCode: '1000',
        creditSplits: [
          { accountCode: '4001', percentageBps: 5000 },
          { accountCode: '4002', percentageBps: 5000 },
        ],
      }],
    });
    const { engine } = setup([transaction], [r]);
    const result = await engine.runOnce({ operatorId: 'op-a', limit: 10 });
    const credits = result.entries[0].lines
      .filter(l => l.side === 'credit')
      .sort((a, b) => a.lineOrder - b.lineOrder);
    assert.equal(credits.length, 2);
    assert.equal(credits[0].amount, 5000);
    assert.equal(credits[1].amount, 5000);
  });

  it('98.5/1.5 split on clean amount allocates each split correctly', async () => {
    // floor(10000 * 9850 / 10000) = 9850; last = 10000 - 9850 = 150
    const transaction = tx({ amount: 10000 });
    const r = rule({
      entries: [{
        debitAccountCode: '1000',
        creditSplits: [
          { accountCode: '4001', percentageBps: 9850 },
          { accountCode: '4002', percentageBps: 150 },
        ],
      }],
    });
    const { engine } = setup([transaction], [r]);
    const result = await engine.runOnce({ operatorId: 'op-a', limit: 10 });
    const credits = result.entries[0].lines
      .filter(l => l.side === 'credit')
      .sort((a, b) => a.lineOrder - b.lineOrder);
    assert.equal(credits[0].amount, 9850);
    assert.equal(credits[1].amount, 150);
  });

  it('98.5/1.5 split on awkward amount: credits always sum to transaction amount', async () => {
    // floor(199 * 9850 / 10000) = floor(196.015) = 196; last = 199 - 196 = 3
    // the last split absorbs the rounding remainder to guarantee balance
    const transaction = tx({ amount: 199 });
    const r = rule({
      entries: [{
        debitAccountCode: '1000',
        creditSplits: [
          { accountCode: '4001', percentageBps: 9850 },
          { accountCode: '4002', percentageBps: 150 },
        ],
      }],
    });
    const { engine } = setup([transaction], [r]);
    const result = await engine.runOnce({ operatorId: 'op-a', limit: 10 });
    const entry = result.entries[0];
    const credits = entry.lines.filter(l => l.side === 'credit').sort((a, b) => a.lineOrder - b.lineOrder);
    const debit = entry.lines.find(l => l.side === 'debit');
    assert.equal(credits[0].amount, 196);
    assert.equal(credits[1].amount, 3);
    assert.equal(credits.reduce((sum, l) => sum + l.amount, 0), debit.amount);
  });

  it('three-way uneven split: each amount is correct and credits sum to transaction amount', async () => {
    // 3333 + 3333 + 3334 = 10000 bps
    // floor(100 * 3333 / 10000) = floor(33.33) = 33 for each of the first two; last = 100 - 33 - 33 = 34
    const transaction = tx({ amount: 100 });
    const r = rule({
      entries: [{
        debitAccountCode: '1000',
        creditSplits: [
          { accountCode: '4001', percentageBps: 3333 },
          { accountCode: '4002', percentageBps: 3333 },
          { accountCode: '4003', percentageBps: 3334 },
        ],
      }],
    });
    const { engine } = setup([transaction], [r]);
    const result = await engine.runOnce({ operatorId: 'op-a', limit: 10 });
    const credits = result.entries[0].lines
      .filter(l => l.side === 'credit')
      .sort((a, b) => a.lineOrder - b.lineOrder);
    assert.equal(credits.length, 3);
    assert.equal(credits[0].amount, 33);
    assert.equal(credits[1].amount, 33);
    assert.equal(credits[2].amount, 34);
    assert.equal(credits.reduce((sum, l) => sum + l.amount, 0), 100);
  });

  it('debit always equals sum of all credit lines', async () => {
    const transaction = tx({ amount: 199 });
    const r = rule({
      entries: [{
        debitAccountCode: '1000',
        creditSplits: [
          { accountCode: '4001', percentageBps: 9850 },
          { accountCode: '4002', percentageBps: 150 },
        ],
      }],
    });
    const { engine } = setup([transaction], [r]);
    const result = await engine.runOnce({ operatorId: 'op-a', limit: 10 });
    const lines = result.entries[0].lines;
    const debitTotal = lines.filter(l => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
    const creditTotal = lines.filter(l => l.side === 'credit').reduce((s, l) => s + l.amount, 0);
    assert.equal(debitTotal, creditTotal);
  });
});

// ── runOnce ───────────────────────────────────────────────────────────────────

describe('runOnce', () => {
  it('unmapped transaction posts to suspense with a balanced entry', async () => {
    const transaction = tx({ product: { line: 'line-z' } });
    const { engine } = setup([transaction], []);
    const result = await engine.runOnce({ operatorId: 'op-a', limit: 10, suspenseAccountCode: '9999' });
    assert.equal(result.generated, 1);
    const entry = result.entries[0];
    assert.equal(entry.entryType, 'unmapped');
    assert.ok(entry.lines.every(l => l.accountCode === '9999'));
    const debitTotal = entry.lines.filter(l => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
    const creditTotal = entry.lines.filter(l => l.side === 'credit').reduce((s, l) => s + l.amount, 0);
    assert.equal(debitTotal, creditTotal);
  });

  it('same transaction is not journaled twice', async () => {
    const transaction = tx();
    const r = rule();
    const { engine } = setup([transaction], [r]);
    const first = await engine.runOnce({ operatorId: 'op-a', limit: 10 });
    const second = await engine.runOnce({ operatorId: 'op-a', limit: 10 });
    assert.equal(first.generated, 1);
    assert.equal(second.generated, 0);
    assert.equal(second.scanned, 0);
  });

  it('test environment transaction is skipped as ineligible', async () => {
    const transaction = tx({ source: { adapter: 'adapter-a', system: 'system-a', environment: 'test' } });
    const r = rule();
    const { engine } = setup([transaction], [r]);
    const result = await engine.runOnce({ operatorId: 'op-a', limit: 10 });
    assert.equal(result.generated, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'ineligible');
  });

  it('pending transaction is skipped as ineligible', async () => {
    const transaction = tx({ status: 'pending', settled_at: null });
    const r = rule();
    const { engine } = setup([transaction], [r]);
    const result = await engine.runOnce({ operatorId: 'op-a', limit: 10 });
    assert.equal(result.generated, 0);
    assert.equal(result.skipped[0].reason, 'ineligible');
  });

  it('reversal entry mirrors original with debit and credit sides flipped', async () => {
    const originalTx = tx({
      id: 'tx-original',
      product: { line: 'line-a', biller: 'biller-a', biller_category: 'cat-a' },
    });
    const r = rule({
      entries: [{
        debitAccountCode: '1000',
        creditSplits: [{ accountCode: '4000', percentageBps: 10000 }],
      }],
    });
    const { repo, engine } = setup([originalTx], [r]);

    await engine.runOnce({ operatorId: 'op-a', limit: 10 });

    const reversalTx = tx({
      id: 'tx-reversal',
      status: 'reversed',
      type: 'system.reversal',
      direction: 'credit',
      reversal_of: 'tx-original',
      settled_at: null,
    });
    repo.transactions.push({ id: reversalTx.id, operatorId: 'op-a', record: reversalTx });

    const result = await engine.runOnce({ operatorId: 'op-a', limit: 10 });
    assert.equal(result.generated, 1);
    const entry = result.entries[0];
    assert.equal(entry.entryType, 'reversal');
    assert.equal(entry.lines.find(l => l.side === 'debit').accountCode, '4000');
    assert.equal(entry.lines.find(l => l.side === 'credit').accountCode, '1000');
  });

  it('reversal without a journaled original is skipped', async () => {
    const reversalTx = tx({
      status: 'reversed',
      type: 'system.reversal',
      direction: 'credit',
      reversal_of: 'tx-nonexistent',
      settled_at: null,
    });
    const { engine } = setup([reversalTx], []);
    const result = await engine.runOnce({ operatorId: 'op-a', limit: 10 });
    assert.equal(result.generated, 0);
    assert.equal(result.skipped[0].reason, 'reversal_original_missing');
  });
});
