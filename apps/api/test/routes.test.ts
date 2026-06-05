import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { InMemoryIngestionRepository, IngestionService } from '@ledgerise/core-ingestion';
import { InMemoryMappingRepository, MappingService } from '@ledgerise/core-mapping';
import { InMemoryJournalEngineRepository, JournalEngineService } from '@ledgerise/core-engine';
import {
  InMemoryPostingRepository,
  PostingService,
  type ApiScope,
} from '@ledgerise/core-posting';

import { InMemoryAccessStore } from '../src/container.js';

import { handleAuthRoutes } from '../src/routes/auth.js';
import { handleMappingRoutes } from '../src/routes/mapping.js';
import { handleCoaRoutes } from '../src/routes/coa.js';
import { handleEngineRoutes } from '../src/routes/engine.js';
import { handleApiKeyRoutes } from '../src/routes/adapters.js';
import { handleUserRoutes } from '../src/routes/users.js';
import { handleSettingsRoutes } from '../src/routes/settings.js';
import { handleIngestionRoutes } from '../src/routes/ingestion.js';
import { handleTransactionRoutes } from '../src/routes/transactions.js';
import { handlePostingRoutes } from '../src/routes/posting.js';

// ── test helpers ──────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const noop = () => {};
const OP = 'test-op';
const principal = { userId: 'user-1', operatorId: OP, role: 'admin' as const };
const getOperatorId = () => OP;

function makeRequest(
  method: string,
  pathname: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): IncomingMessage {
  const stream = new Readable({ read() {} });
  if (body !== undefined) stream.push(JSON.stringify(body));
  stream.push(null);
  return Object.assign(stream, {
    method,
    url: pathname,
    headers: { host: 'localhost', ...extraHeaders },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage;
}

interface Captured {
  status: number;
  body: unknown;
}

function makeResponse(): ServerResponse & { captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  return {
    captured,
    headersSent: false,
    writeHead(code: number) {
      captured.status = code;
    },
    end(data?: string) {
      if (data) {
        try { captured.body = JSON.parse(data); } catch { captured.body = data; }
      }
      (this as unknown as { headersSent: boolean }).headersSent = true;
    },
    setHeader() {},
  } as unknown as ServerResponse & { captured: Captured };
}

function url(pathname: string, search = ''): URL {
  return new URL(`http://localhost${pathname}${search}`);
}

// ── routes/auth.ts ────────────────────────────────────────────────────────────

describe('routes/auth', () => {
  it('POST /api/auth/login with missing credentials returns 400 INVALID_LOGIN', async () => {
    const accessStore = new InMemoryAccessStore();
    const req = makeRequest('POST', '/api/auth/login', {});
    const res = makeResponse();

    const handled = await handleAuthRoutes(req, res, url('/api/auth/login'), {
      accessStore,
      getOperatorId,
      log: noop,
    });

    assert.equal(handled, true);
    assert.equal(res.captured.status, 400);
    assert.equal((res.captured.body as Record<string, unknown>).code, 'INVALID_LOGIN');
  });
});

// ── routes/mapping.ts ─────────────────────────────────────────────────────────

describe('routes/mapping', () => {
  it('GET /api/mapping-rules returns empty records', async () => {
    const mappingService = new MappingService(new InMemoryMappingRepository());
    const req = makeRequest('GET', '/api/mapping-rules');
    const res = makeResponse();

    const handled = await handleMappingRoutes(req, res, url('/api/mapping-rules'), {
      mappingService,
      dashboardPrincipal: principal,
      getOperatorId,
    });

    assert.equal(handled, true);
    assert.equal(res.captured.status, 200);
    assert.deepEqual((res.captured.body as Record<string, unknown>).records, []);
  });

  it('POST /api/mapping-rules accepts a 98.5 : 1.5 credit split', async () => {
    const mappingService = new MappingService(new InMemoryMappingRepository());
    const req = makeRequest('POST', '/api/mapping-rules', {
      product_line: 'payments',
      rule_type: 'simple',
      entries: [
        {
          debit_account_code: '1000',
          credit_splits: [
            { account_code: '2000', percentage_bps: 9850 },
            { account_code: '2001', percentage_bps: 150 },
          ],
        },
      ],
    });
    const res = makeResponse();

    const handled = await handleMappingRoutes(req, res, url('/api/mapping-rules'), {
      mappingService,
      dashboardPrincipal: principal,
      getOperatorId,
    });

    assert.equal(handled, true);
    assert.equal(res.captured.status, 201);
    const record = (res.captured.body as Record<string, unknown>).record as Record<string, unknown>;
    const entries = record.entries as Array<Record<string, unknown>>;
    const splits = entries[0].creditSplits as Array<Record<string, unknown>>;
    assert.equal(splits[0].percentageBps, 9850);
    assert.equal(splits[1].percentageBps, 150);
  });
});

// ── routes/coa.ts ─────────────────────────────────────────────────────────────

describe('routes/coa', () => {
  it('GET /api/coa returns empty records', async () => {
    const mappingService = new MappingService(new InMemoryMappingRepository());
    const req = makeRequest('GET', '/api/coa');
    const res = makeResponse();

    const handled = await handleCoaRoutes(req, res, url('/api/coa'), {
      mappingService,
      dashboardPrincipal: principal,
      getOperatorId,
    });

    assert.equal(handled, true);
    assert.equal(res.captured.status, 200);
    assert.deepEqual((res.captured.body as Record<string, unknown>).records, []);
  });
});

// ── routes/engine.ts ──────────────────────────────────────────────────────────

describe('routes/engine', () => {
  it('GET /api/journal-entries returns records and page', async () => {
    const postingRepo = new InMemoryPostingRepository();
    const postingService = new PostingService(postingRepo);
    const engineService = new JournalEngineService(new InMemoryJournalEngineRepository());
    const req = makeRequest('GET', '/api/journal-entries');
    const res = makeResponse();

    const handled = await handleEngineRoutes(req, res, url('/api/journal-entries'), {
      engineService,
      postingService,
      pgPool: null,
      dashboardPrincipal: principal,
      getOperatorId,
      log: noop,
    });

    assert.equal(handled, true);
    assert.equal(res.captured.status, 200);
    const body = res.captured.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.records));
    assert.ok(body.page);
  });
});

// ── routes/adapters.ts ────────────────────────────────────────────────────────

describe('routes/adapters', () => {
  it('GET /api/api-keys returns empty records', async () => {
    const accessStore = new InMemoryAccessStore();
    const req = makeRequest('GET', '/api/api-keys');
    const res = makeResponse();

    const handled = await handleApiKeyRoutes(req, res, url('/api/api-keys'), {
      accessStore,
      dashboardPrincipal: principal,
      getOperatorId,
    });

    assert.equal(handled, true);
    assert.equal(res.captured.status, 200);
    assert.deepEqual((res.captured.body as Record<string, unknown>).records, []);
  });
});

// ── routes/users.ts ───────────────────────────────────────────────────────────

describe('routes/users', () => {
  it('GET /api/users returns empty records', async () => {
    const accessStore = new InMemoryAccessStore();
    const req = makeRequest('GET', '/api/users');
    const res = makeResponse();

    const handled = await handleUserRoutes(req, res, url('/api/users'), {
      accessStore,
      dashboardPrincipal: principal,
      getOperatorId,
    });

    assert.equal(handled, true);
    assert.equal(res.captured.status, 200);
    assert.deepEqual((res.captured.body as Record<string, unknown>).records, []);
  });
});

// ── routes/settings.ts ────────────────────────────────────────────────────────

describe('routes/settings', () => {
  it('GET /api/system-settings returns default settings', async () => {
    const req = makeRequest('GET', '/api/system-settings');
    const res = makeResponse();

    const handled = await handleSettingsRoutes(req, res, url('/api/system-settings'), {
      pgPool: null,
      dashboardPrincipal: principal,
      getOperatorId,
    });

    assert.equal(handled, true);
    assert.equal(res.captured.status, 200);
    const body = res.captured.body as Record<string, unknown>;
    assert.ok(body.record);
  });
});

// ── routes/ingestion.ts ───────────────────────────────────────────────────────

describe('routes/ingestion', () => {
  it('GET /api/adapters returns the registered adapter list', async () => {
    const ingestionRepo = new InMemoryIngestionRepository();
    const ingestionService = new IngestionService(ingestionRepo);
    const req = makeRequest('GET', '/api/adapters');
    const res = makeResponse();

    const handled = await handleIngestionRoutes(req, res, url('/api/adapters'), {
      ingestionService,
      ingestionRepository: ingestionRepo,
      dashboardPrincipal: null,
      getOperatorId,
      defaultOperatorId: OP,
      log: noop,
    });

    assert.equal(handled, true);
    assert.equal(res.captured.status, 200);
    const body = res.captured.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.records));
    assert.ok((body.records as unknown[]).length > 0);
  });
});

// ── routes/transactions.ts ────────────────────────────────────────────────────

describe('routes/transactions', () => {
  it('GET /api/transactions returns records and page', async () => {
    const ingestionRepo = new InMemoryIngestionRepository();
    const req = makeRequest('GET', '/api/transactions');
    const res = makeResponse();

    const handled = await handleTransactionRoutes(req, res, url('/api/transactions'), {
      ingestionRepository: ingestionRepo,
      pgPool: null,
      dashboardPrincipal: principal,
      getOperatorId,
      log: noop,
    });

    assert.equal(handled, true);
    assert.equal(res.captured.status, 200);
    const body = res.captured.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.records));
    assert.ok(body.page);
  });
});

// ── routes/posting.ts ─────────────────────────────────────────────────────────

describe('routes/posting', () => {
  it('GET /api/posting-batches with a valid API key returns records and page', async () => {
    const postingRepo = new InMemoryPostingRepository();
    postingRepo.apiKeys.push({
      id: 'key-1',
      operatorId: OP,
      name: 'test-key',
      scopes: ['posting_batches:read'] as ApiScope[],
      keyHash: sha256('test-secret'),
    });
    const postingService = new PostingService(postingRepo);
    const req = makeRequest('GET', '/api/posting-batches', undefined, {
      'x-api-key': 'test-secret',
    });
    const res = makeResponse();

    const handled = await handlePostingRoutes(req, res, url('/api/posting-batches'), {
      postingService,
    });

    assert.equal(handled, true);
    assert.equal(res.captured.status, 200);
    const body = res.captured.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.records));
    assert.ok(body.page);
  });

  it('GET /api/posting-batches without an API key returns 401', async () => {
    const postingService = new PostingService(new InMemoryPostingRepository());
    const req = makeRequest('GET', '/api/posting-batches');
    const res = makeResponse();

    const handled = await handlePostingRoutes(req, res, url('/api/posting-batches'), {
      postingService,
    });

    assert.equal(handled, true);
    assert.equal(res.captured.status, 401);
    assert.equal((res.captured.body as Record<string, unknown>).code, 'API_KEY_REQUIRED');
  });
});
