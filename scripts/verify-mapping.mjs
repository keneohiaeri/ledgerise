import { spawn } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/ledgerise';
const port = process.env.VERIFY_API_PORT ?? '3200';
const baseUrl = `http://127.0.0.1:${port}`;
const codePrefix = `VERIFY-${Date.now()}`;

const accounts = [
  { code: `${codePrefix}-1000`, name: 'Verification Cash', type: 'asset' },
  { code: `${codePrefix}-4000`, name: 'Verification Revenue', type: 'revenue' },
  { code: `${codePrefix}-4010`, name: 'Verification Split Revenue', type: 'revenue' }
];

const api = spawn('node', ['apps/api/dist/index.js'], {
  env: {
    ...process.env,
    API_PORT: port,
    DATABASE_URL: databaseUrl,
    DEFAULT_OPERATOR_SLUG: process.env.DEFAULT_OPERATOR_SLUG ?? 'local-operator'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let apiOutput = '';
api.stdout.on('data', (chunk) => {
  apiOutput += chunk.toString();
});
api.stderr.on('data', (chunk) => {
  apiOutput += chunk.toString();
});

try {
  await waitForHealthcheck();

  const healthcheck = await getJson('/healthcheck');
  assertEqual(healthcheck.body.repository, 'postgres', 'healthcheck repository');

  const importResult = await postJson('/api/coa/import', { accounts });
  assertEqual(importResult.statusCode, 200, 'COA import status');
  assertEqual(importResult.body.records.length, accounts.length, 'COA import count');

  const coa = await getJson('/api/coa');
  assertEqual(coa.statusCode, 200, 'COA list status');
  assert(
    coa.body.records.some((account) => account.code === accounts[0].code),
    'COA list includes imported account'
  );

  const invalidRule = await postJson('/api/mapping-rules', {
    product_line: 'consumer-app',
    debit_account_code: accounts[0].code,
    credit_splits: [{ account_code: accounts[1].code, percentage_bps: 9000 }]
  });
  assertEqual(invalidRule.statusCode, 400, 'invalid mapping rule status');

  const createdRule = await postJson('/api/mapping-rules', {
    product_line: 'consumer-app',
    biller: 'ikeja-electric',
    biller_category: 'electricity',
    transaction_type: 'payment.electricity',
    debit_account_code: accounts[0].code,
    credit_splits: [{ account_code: accounts[1].code, percentage_bps: 10000 }]
  });
  assertEqual(createdRule.statusCode, 201, 'mapping rule create status');
  assertEqual(createdRule.body.record.version, 1, 'mapping rule initial version');

  const ruleId = createdRule.body.record.id;
  const updatedRule = await patchJson(`/api/mapping-rules/${ruleId}`, {
    credit_splits: [
      { account_code: accounts[1].code, percentage_bps: 7000 },
      { account_code: accounts[2].code, percentage_bps: 3000 }
    ]
  });
  assertEqual(updatedRule.statusCode, 200, 'mapping rule update status');
  assertEqual(updatedRule.body.record.version, 2, 'mapping rule updated version');
  assertEqual(updatedRule.body.record.creditSplits.length, 2, 'mapping rule split count');

  const deactivatedRule = await postJson(`/api/mapping-rules/${ruleId}/deactivate`, {});
  assertEqual(deactivatedRule.statusCode, 200, 'mapping rule deactivate status');
  assertEqual(deactivatedRule.body.record.status, 'inactive', 'mapping rule inactive status');

  const activatedRule = await postJson(`/api/mapping-rules/${ruleId}/activate`, {});
  assertEqual(activatedRule.statusCode, 200, 'mapping rule activate status');
  assertEqual(activatedRule.body.record.status, 'active', 'mapping rule active status');

  const rules = await getJson('/api/mapping-rules');
  assertEqual(rules.statusCode, 200, 'mapping rule list status');
  assert(
    rules.body.records.some((rule) => rule.id === ruleId),
    'mapping rule list includes verified rule'
  );

  console.log('Mapping and COA verification passed.');
  console.log(
    JSON.stringify(
      {
        rule_id: ruleId,
        rule_version: activatedRule.body.record.version,
        imported_accounts: accounts.map((account) => account.code)
      },
      null,
      2
    )
  );
} catch (error) {
  console.error('Mapping and COA verification failed.');
  console.error(error instanceof Error ? error.message : error);
  if (apiOutput.trim()) {
    console.error('\nAPI output:');
    console.error(apiOutput.trim());
  }
  process.exitCode = 1;
} finally {
  api.kill();
}

async function waitForHealthcheck() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (api.exitCode !== null) throw new Error(`API process exited early with code ${api.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/healthcheck`);
      if (response.ok) return;
    } catch {
      // Wait and retry.
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for API healthcheck');
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { statusCode: response.status, body: await response.json() };
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { statusCode: response.status, body: await response.json() };
}

async function patchJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { statusCode: response.status, body: await response.json() };
}

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${label}. Expected ${expected}, got ${actual}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
