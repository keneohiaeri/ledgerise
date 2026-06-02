import { randomUUID } from 'node:crypto';

import { postJournals } from '@ledgerise/adapter-outbound-generic-journal-csv';
import pg from 'pg';

import { JournalEngineService } from '@ledgerise/core-engine';
import { PostgresJournalEngineRepository } from '@ledgerise/core-engine/postgres';
import { IngestionService } from '@ledgerise/core-ingestion';
import { PostgresIngestionRepository } from '@ledgerise/core-ingestion/postgres';
import { MappingService } from '@ledgerise/core-mapping';
import { PostgresMappingRepository } from '@ledgerise/core-mapping/postgres';
import { PostingService } from '@ledgerise/core-posting';
import { PostgresPostingRepository } from '@ledgerise/core-posting/postgres';
import { settledBillPayment } from '@ledgerise/test-fixtures';

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/ledgerise';
const codePrefix = `OUTCSV-${Date.now()}`;
const productLine = `outbound-csv-product-${Date.now()}`;
const { Pool } = pg;

const pool = new Pool({ connectionString: databaseUrl });
const ingestionRepository = new PostgresIngestionRepository(pool);
const mappingRepository = new PostgresMappingRepository(pool);
const engineRepository = new PostgresJournalEngineRepository(pool);
const postingRepository = new PostgresPostingRepository(pool);
const ingestionService = new IngestionService(ingestionRepository);
const mappingService = new MappingService(mappingRepository);
const engine = new JournalEngineService(engineRepository, { suspenseAccountCode: `${codePrefix}-9999` });
const posting = new PostingService(postingRepository);

try {
  const operatorId =
    process.env.DEFAULT_OPERATOR_ID ??
    (await ingestionRepository.findOperatorIdBySlug(process.env.DEFAULT_OPERATOR_SLUG ?? 'local-operator'));

  if (!operatorId) {
    throw new Error('No default operator found. Run infra/seed/0001_local_operator_and_adapters.sql first.');
  }

  const accounts = [
    { code: `${codePrefix}-1000`, name: 'Outbound CSV Verification Cash', type: 'asset' },
    { code: `${codePrefix}-4000`, name: 'Outbound CSV Verification Revenue', type: 'revenue' },
    { code: `${codePrefix}-9999`, name: 'Outbound CSV Verification Suspense', type: 'liability' }
  ];
  await mappingService.importChartAccounts(operatorId, accounts);

  await mappingService.createMappingRule(operatorId, {
    productLine,
    biller: 'ikeja-electric',
    transactionType: 'payment.electricity',
    debitAccountCode: accounts[0].code,
    creditSplits: [{ accountCode: accounts[1].code, percentageBps: 10000 }]
  });

  const transaction = {
    ...settledBillPayment,
    id: randomUUID(),
    source_id: `${codePrefix}-source`,
    source: {
      ...settledBillPayment.source,
      adapter: 'generic-webhook'
    },
    product: {
      line: productLine,
      biller: 'ikeja-electric',
      biller_category: 'electricity'
    }
  };

  const ingestResult = await ingestionService.ingestCanonicalTransaction({
    operatorId,
    adapterName: 'generic-webhook',
    record: transaction
  });
  assertEqual(ingestResult.status, 'accepted', 'transaction accepted');

  const engineResult = await engine.runOnce({ operatorId, limit: 5000 });
  const entry = engineResult.entries.find((item) => item.transactionId === transaction.id);
  assert(entry, 'engine generated outbound CSV verification entry');

  const batch = await posting.createPostingBatch({
    operatorId,
    adapterName: 'generic-journal-csv',
    journalEntryIds: [entry.id],
    limit: 1
  });
  assertEqual(batch.entries.length, 1, 'posting batch claims one entry');
  assertEqual(batch.entries[0].id, entry.id, 'posting batch claims the generated entry');

  const outboundBatch = {
    id: batch.id,
    operator_id: batch.operatorId,
    adapter_name: batch.adapterName,
    created_at: batch.createdAt,
    entries: batch.entries.map((journalEntry) => ({
      id: journalEntry.id,
      transaction_id: journalEntry.transactionId,
      source_id: journalEntry.transaction?.sourceId,
      transaction_type: journalEntry.transaction?.type,
      product_line: journalEntry.transaction?.productLine,
      product_biller: journalEntry.transaction?.productBiller,
      entry_type: journalEntry.entryType,
      currency: journalEntry.currency,
      amount: journalEntry.amount,
      generated_at: journalEntry.generatedAt,
      mapping_rule_id: journalEntry.mappingRuleId,
      mapping_rule_version: journalEntry.mappingRuleVersion,
      lines: journalEntry.lines.map((line) => ({
        account_code: line.accountCode,
        side: line.side,
        amount: line.amount,
        currency: line.currency,
        line_order: line.lineOrder
      }))
    }))
  };
  const adapterResult = await postJournals(outboundBatch);
  assertEqual(adapterResult.status, 'ok', 'CSV adapter posts batch');
  assert(adapterResult.artifact?.content.includes('journal_entry_id'), 'CSV includes header');
  assert(adapterResult.artifact?.content.includes(entry.id), 'CSV includes journal entry id');

  const completed = await posting.completePostingBatch({
    operatorId,
    batchId: batch.id,
    adapterName: 'generic-journal-csv',
    results: adapterResult.posted.map((result) => ({
      journalEntryId: result.journal_entry_id,
      status: 'posted',
      externalReference: result.external_reference
    }))
  });
  assertEqual(completed?.status, 'posted', 'posting batch marked posted');

  const postedEntry = await posting.findJournalEntry({ operatorId, journalEntryId: entry.id });
  assertEqual(postedEntry?.postingStatus, 'posted', 'journal entry marked posted');
  assertEqual(postedEntry?.latestAttempt?.status, 'posted', 'latest attempt marked posted');
  assert(postedEntry?.latestAttempt?.externalReference?.startsWith('csv:'), 'external reference recorded');

  console.log('Outbound CSV verification passed.');
  console.log(
    JSON.stringify(
      {
        posting_batch_id: batch.id,
        journal_entry_id: entry.id,
        csv_rows: adapterResult.artifact?.content.trim().split('\n').length,
        external_reference: postedEntry?.latestAttempt?.externalReference
      },
      null,
      2
    )
  );
} catch (error) {
  console.error('Outbound CSV verification failed.');
  console.error(error instanceof Error ? error.stack : JSON.stringify(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${label}. Expected ${expected}, got ${actual}`);
  }
}
