import { randomUUID } from 'node:crypto';

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
const codePrefix = `POSTING-${Date.now()}`;
const productLine = `posting-product-${Date.now()}`;
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
    { code: `${codePrefix}-1000`, name: 'Posting Verification Cash', type: 'asset' },
    { code: `${codePrefix}-4000`, name: 'Posting Verification Revenue', type: 'revenue' },
    { code: `${codePrefix}-9999`, name: 'Posting Verification Suspense', type: 'liability' }
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
    },
    metadata: {
      ...settledBillPayment.metadata,
      verification_label: codePrefix
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
  assert(entry, 'engine generated posting verification entry');

  let journalLog = await posting.listJournalEntries({ operatorId, limit: 20, offset: 0 });
  assert(
    journalLog.records.some((item) => item.id === entry.id && item.postingStatus === 'generated'),
    'journal log includes generated entry'
  );

  await pool.query(
    `
      UPDATE journal_entries
      SET
        posting_status = 'failed',
        last_posting_error = 'Verification outbound failure',
        last_posting_attempt_at = now()
      WHERE operator_id = $1 AND id = $2
    `,
    [operatorId, entry.id]
  );

  const failedDetail = await posting.findJournalEntry({ operatorId, journalEntryId: entry.id });
  assertEqual(failedDetail?.postingStatus, 'failed', 'journal detail exposes failed status');

  const retried = await posting.requestManualRetry({
    operatorId,
    journalEntryId: entry.id,
    adapterName: 'generic-journal-csv'
  });
  assertEqual(retried?.postingStatus, 'generated', 'manual retry returns entry to generated queue');
  assertEqual(retried?.attemptCount, 1, 'manual retry records an attempt');
  assertEqual(retried?.latestAttempt?.status, 'retry_requested', 'latest attempt status');
  assertEqual(retried?.latestAttempt?.adapterName, 'generic-journal-csv', 'latest attempt adapter');

  journalLog = await posting.listJournalEntries({
    operatorId,
    limit: 20,
    offset: 0,
    postingStatus: 'generated'
  });
  assert(
    journalLog.records.some((item) => item.id === entry.id),
    'generated journal log filter includes retried entry'
  );

  console.log('Posting queue verification passed.');
  console.log(
    JSON.stringify(
      {
        journal_entry_id: entry.id,
        retry_attempt_id: retried?.latestAttempt?.id,
        posting_status: retried?.postingStatus
      },
      null,
      2
    )
  );
} catch (error) {
  console.error('Posting queue verification failed.');
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
