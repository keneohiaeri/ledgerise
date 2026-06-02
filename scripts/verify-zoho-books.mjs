import { postJournals, toZohoJournalPayload, validate } from '@ledgerise/adapter-outbound-zoho-books';
import {
  zohoSandboxAccountMap,
  zohoSandboxBatch
} from '../adapters/outbound/zoho-books/dist/fixtures/sandbox-journal.js';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const requests = [];

try {
  process.env.ZOHO_BOOKS_ORGANIZATION_ID = '10234695';
  process.env.ZOHO_BOOKS_ACCESS_TOKEN = 'test-access-token';
  process.env.ZOHO_BOOKS_ACCOUNT_MAP_JSON = JSON.stringify(zohoSandboxAccountMap);
  process.env.ZOHO_BOOKS_JOURNAL_STATUS = 'draft';

  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        code: 0,
        message: 'The journal entry has been created.',
        journal: {
          journal_id: '460000000038001',
          entry_number: '1',
          reference_number: 'BILLPAY-20260602-0001'
        }
      }),
      {
        status: 201,
        headers: { 'content-type': 'application/json' }
      }
    );
  };

  const validation = validate(zohoSandboxBatch);
  assertEqual(validation.valid, true, 'sandbox batch validates');

  const payload = toZohoJournalPayload('batch-1', zohoSandboxBatch.entries[0], {
    organizationId: '10234695',
    accessToken: 'test-access-token',
    accountsBaseUrl: 'https://accounts.zoho.com',
    apiBaseUrl: 'https://www.zohoapis.com/books/v3',
    accountMap: zohoSandboxAccountMap,
    amountScale: 100,
    status: 'draft'
  });
  assertEqual(payload.journal_date, '2026-06-02', 'journal date');
  assertEqual(payload.reference_number, 'BILLPAY-20260602-0001', 'reference number');
  assertEqual(payload.line_items[0].account_id, zohoSandboxAccountMap['1000'], 'debit account mapping');
  assertEqual(payload.line_items[0].amount, 5000, 'minor units converted to major units');
  assertEqual(payload.line_items[1].debit_or_credit, 'credit', 'credit side');

  const result = await postJournals(zohoSandboxBatch);
  assertEqual(result.status, 'ok', 'post result status');
  assertEqual(result.posted.length, 1, 'posted count');
  assertEqual(result.failed.length, 0, 'failed count');
  assertEqual(result.posted[0].external_reference, 'zoho-books:460000000038001', 'external reference');
  assert(requests[0].url.includes('/books/v3/journals?organization_id=10234695'), 'journal endpoint called');

  const failedBatch = {
    ...zohoSandboxBatch,
    entries: [
      {
        ...zohoSandboxBatch.entries[0],
        id: 'e0000000-0000-4000-8000-000000000002',
        lines: [
          {
            ...zohoSandboxBatch.entries[0].lines[0],
            account_code: '9999'
          },
          zohoSandboxBatch.entries[0].lines[1]
        ]
      }
    ]
  };
  const failedValidation = validate(failedBatch);
  assertEqual(failedValidation.valid, false, 'missing account map fails validation');

  console.log('Zoho Books adapter verification passed.');
  console.log(
    JSON.stringify(
      {
        journal_id: result.posted[0].external_reference,
        requests: requests.length,
        reference_number: payload.reference_number
      },
      null,
      2
    )
  );
} catch (error) {
  console.error('Zoho Books adapter verification failed.');
  console.error(error instanceof Error ? error.stack : JSON.stringify(error));
  process.exitCode = 1;
} finally {
  process.env = originalEnv;
  globalThis.fetch = originalFetch;
}

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${label}. Expected ${expected}, got ${actual}`);
  }
}
