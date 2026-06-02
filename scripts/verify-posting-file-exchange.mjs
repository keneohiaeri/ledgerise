import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import pg from 'pg';

import { JournalEngineService } from '@ledgerise/core-engine';
import { PostgresJournalEngineRepository } from '@ledgerise/core-engine/postgres';
import { IngestionService } from '@ledgerise/core-ingestion';
import { PostgresIngestionRepository } from '@ledgerise/core-ingestion/postgres';
import { MappingService } from '@ledgerise/core-mapping';
import { PostgresMappingRepository } from '@ledgerise/core-mapping/postgres';
import { settledBillPayment } from '@ledgerise/test-fixtures';

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/ledgerise';
const port = Number(process.env.API_PORT ?? 3410);
const baseUrl = `http://127.0.0.1:${port}`;
const codePrefix = `FILEX-${Date.now()}`;
const productLine = `file-exchange-product-${Date.now()}`;
const { Pool } = pg;

const pool = new Pool({ connectionString: databaseUrl });
const ingestionRepository = new PostgresIngestionRepository(pool);
const mappingRepository = new PostgresMappingRepository(pool);
const engineRepository = new PostgresJournalEngineRepository(pool);
const ingestionService = new IngestionService(ingestionRepository);
const mappingService = new MappingService(mappingRepository);
const engine = new JournalEngineService(engineRepository, { suspenseAccountCode: `${codePrefix}-9999` });
let api;

try {
  const operatorId =
    process.env.DEFAULT_OPERATOR_ID ??
    (await ingestionRepository.findOperatorIdBySlug(process.env.DEFAULT_OPERATOR_SLUG ?? 'local-operator'));

  if (!operatorId) {
    throw new Error('No default operator found. Run infra/seed/0001_local_operator_and_adapters.sql first.');
  }

  const apiKey = `ledg_test_${randomUUID()}`;
  await pool.query(
    `
      INSERT INTO api_keys (operator_id, name, key_prefix, key_hash, scopes)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [
      operatorId,
      `${codePrefix} file exchange key`,
      apiKey.slice(0, 16),
      sha256(apiKey),
      ['posting_batches:create', 'posting_batches:read', 'posting_artifacts:download']
    ]
  );

  const accounts = [
    { code: `${codePrefix}-1000`, name: 'File Exchange Verification Cash', type: 'asset' },
    { code: `${codePrefix}-4000`, name: 'File Exchange Verification Revenue', type: 'revenue' },
    { code: `${codePrefix}-9999`, name: 'File Exchange Verification Suspense', type: 'liability' }
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
  assert(entry, 'engine generated file exchange verification entry');

  api = spawn(process.execPath, ['apps/api/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_PORT: String(port),
      DATABASE_URL: databaseUrl
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForApi();

  const unauthorized = await fetch(`${baseUrl}/api/posting-batches/generic-journal-csv`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ journal_entry_ids: [entry.id], limit: 1 })
  });
  assertEqual(unauthorized.status, 401, 'posting batch creation requires API key');

  const idempotencyKey = `${codePrefix}-nightly`;
  const created = await fetchJson(`${baseUrl}/api/posting-batches/generic-journal-csv`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey
    },
    body: JSON.stringify({ journal_entry_ids: [entry.id], limit: 1 })
  });
  assertEqual(created.status, 201, 'posting batch created');
  assertEqual(created.body.status, 'ok', 'posting batch result ok');
  assertEqual(created.body.replayed, false, 'first create is not replayed');
  assert(created.body.artifact?.content.includes(entry.id), 'create response includes CSV content');

  const replayed = await fetchJson(`${baseUrl}/api/posting-batches/generic-journal-csv`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey
    },
    body: JSON.stringify({ journal_entry_ids: [entry.id], limit: 1 })
  });
  assertEqual(replayed.status, 200, 'idempotent replay returns existing batch');
  assertEqual(replayed.body.replayed, true, 'second create is replayed');
  assertEqual(replayed.body.batch.id, created.body.batch.id, 'replay returns same batch');

  const list = await fetchJson(`${baseUrl}/api/posting-batches?limit=5`, {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  assertEqual(list.status, 200, 'posting batch list succeeds');
  assert(
    list.body.records.some((batch) => batch.id === created.body.batch.id),
    'posting batch list includes created batch'
  );

  const detail = await fetchJson(`${baseUrl}/api/posting-batches/${created.body.batch.id}`, {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  assertEqual(detail.status, 200, 'posting batch detail succeeds');
  assertEqual(detail.body.record.artifact.filename, created.body.artifact.filename, 'detail includes artifact metadata');

  const download = await fetch(`${baseUrl}/api/posting-batches/${created.body.batch.id}/artifact.csv`, {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  const csv = await download.text();
  assertEqual(download.status, 200, 'artifact download succeeds');
  assert(csv.includes('journal_entry_id'), 'downloaded CSV includes header');
  assert(csv.includes(entry.id), 'downloaded CSV includes journal entry');

  const audit = await pool.query(
    `
      SELECT COUNT(*)::int AS total
      FROM posting_artifact_downloads
      WHERE posting_batch_id = $1
    `,
    [created.body.batch.id]
  );
  assertEqual(audit.rows[0]?.total, 1, 'artifact download is audited');

  console.log('Posting file exchange verification passed.');
  console.log(
    JSON.stringify(
      {
        posting_batch_id: created.body.batch.id,
        journal_entry_id: entry.id,
        artifact_filename: created.body.artifact.filename,
        checksum_sha256: created.body.artifact.checksum_sha256
      },
      null,
      2
    )
  );
} catch (error) {
  console.error('Posting file exchange verification failed.');
  console.error(error instanceof Error ? error.stack : JSON.stringify(error));
  process.exitCode = 1;
} finally {
  if (api && !api.killed) api.kill();
  await pool.end();
}

async function waitForApi() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthcheck`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('API did not start in time');
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { status: response.status, body };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${label}. Expected ${expected}, got ${actual}`);
  }
}
