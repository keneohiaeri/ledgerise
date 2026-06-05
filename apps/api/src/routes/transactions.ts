import type { IncomingMessage, ServerResponse } from 'node:http';

import pg from 'pg';

import {
  type IngestionErrorListInput,
  type IngestionRepository,
  type StoredCanonicalTransaction,
  type StoredIngestionError,
  type TransactionListInput,
} from '@ledgerise/core-ingestion';

import { type AuthPrincipal, requireRole } from '../middleware/auth.js';
import { sendJson } from '../lib/http.js';
import {
  getQueryParam,
  invalidQuery,
  parsePagination,
  type ParsedQuery,
  validateDateRange,
} from '../lib/query.js';

type LogFn = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;

interface TransactionRouteDeps {
  ingestionRepository: IngestionRepository;
  pgPool: pg.Pool | null;
  dashboardPrincipal: AuthPrincipal;
  getOperatorId: (request: IncomingMessage) => string;
  log: LogFn;
}

const transactionStatuses = new Set(['pending', 'settled', 'failed', 'reversed', 'disputed']);
const postingStatuses = new Set(['unposted']);
const environments = new Set(['live', 'test']);
const ingestionErrorTypes = new Set([
  'schema_validation',
  'adapter_mismatch',
  'duplicate_source',
]);

export function toTransactionSummary(transaction: StoredCanonicalTransaction) {
  return {
    id: transaction.id,
    source_id: transaction.record.source_id,
    source: transaction.record.source,
    occurred_at: transaction.record.occurred_at,
    settled_at: transaction.record.settled_at,
    status: transaction.record.status,
    posting_status: transaction.postingStatus,
    type: transaction.record.type,
    direction: transaction.record.direction,
    amount: transaction.record.amount,
    currency: transaction.record.currency,
    product: transaction.record.product,
    channel: transaction.record.channel,
    dedupe_confidence: transaction.dedupeConfidence,
    ingested_at: transaction.ingestedAt,
  };
}

export function toTransactionDetail(transaction: StoredCanonicalTransaction) {
  return {
    ...toTransactionSummary(transaction),
    canonical_record: transaction.record,
  };
}

export function toIngestionErrorResponse(error: StoredIngestionError) {
  return {
    id: error.id,
    adapter_name: error.adapterName,
    error_type: error.errorType,
    source_system: error.sourceSystem,
    source_id: error.sourceId,
    existing_transaction_id: error.existingTransactionId,
    validation_errors: error.validationErrors,
    raw_record: error.rawRecord,
    occurred_at: error.occurredAt,
  };
}

export async function handleTransactionRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: TransactionRouteDeps
): Promise<boolean> {
  const { ingestionRepository, pgPool, dashboardPrincipal, getOperatorId, log: _log } = deps;

  if (request.method === 'GET' && url.pathname === '/api/transactions/stats') {
    if (!requireRole(dashboardPrincipal, response, ['admin', 'finance', 'auditor'])) return true;
    const operatorId = getOperatorId(request);
    if (!pgPool) {
      sendJson(response, 200, { stats: { settled: 0, pendingTest: 0, unmapped: 0 } });
      return true;
    }
    const result = await pgPool.query<{ settled: string; pending_test: string; unmapped: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'settled' AND source_environment != 'test')::text AS settled,
         COUNT(*) FILTER (WHERE status != 'settled' OR source_environment = 'test')::text AS pending_test,
         (SELECT COUNT(DISTINCT transaction_id)::text FROM journal_entries
          WHERE operator_id = $1 AND posting_status = 'unmapped') AS unmapped
       FROM canonical_transactions WHERE operator_id = $1`,
      [operatorId]
    );
    const row = result.rows[0];
    sendJson(response, 200, {
      stats: {
        settled: Number(row?.settled ?? 0),
        pendingTest: Number(row?.pending_test ?? 0),
        unmapped: Number(row?.unmapped ?? 0),
      },
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/transactions') {
    const operatorId = getOperatorId(request);
    const filters = parseTransactionListQuery(url, operatorId);

    if (!filters.ok) {
      sendJson(response, 400, filters.error);
      return true;
    }

    const transactions = await ingestionRepository.listTransactions(filters.value);

    sendJson(response, 200, {
      records: transactions.records.map(toTransactionSummary),
      page: transactions.page,
    });
    return true;
  }

  const transactionMatch = /^\/api\/transactions\/([^/]+)$/.exec(url.pathname);

  if (request.method === 'GET' && transactionMatch) {
    const operatorId = getOperatorId(request);
    const transactionId = decodeURIComponent(transactionMatch[1] ?? '');
    const transaction = await ingestionRepository.findTransactionById({ operatorId, transactionId });

    if (!transaction) {
      sendJson(response, 404, {
        status: 'error',
        code: 'TRANSACTION_NOT_FOUND',
        message: `Transaction "${transactionId}" was not found`,
      });
      return true;
    }

    sendJson(response, 200, { record: toTransactionDetail(transaction) });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/ingestion-errors') {
    const operatorId = getOperatorId(request);
    const filters = parseIngestionErrorListQuery(url, operatorId);

    if (!filters.ok) {
      sendJson(response, 400, filters.error);
      return true;
    }

    const ingestionErrors = await ingestionRepository.listIngestionErrors(filters.value);

    sendJson(response, 200, {
      records: ingestionErrors.records.map(toIngestionErrorResponse),
      page: ingestionErrors.page,
    });
    return true;
  }

  return false;
}

function parseTransactionListQuery(
  url: URL,
  operatorId: string
): ParsedQuery<TransactionListInput> {
  const pagination = parsePagination(url);
  if (!pagination.ok) return pagination;

  const status = getQueryParam(url, 'status');
  const postingStatus = getQueryParam(url, 'posting_status');
  const environment = getQueryParam(url, 'environment');
  const occurredFrom = getQueryParam(url, 'occurred_from');
  const occurredTo = getQueryParam(url, 'occurred_to');
  const dateValidation = validateDateRange(occurredFrom, occurredTo);

  if (status && !transactionStatuses.has(status)) {
    return invalidQuery(`Unsupported transaction status "${status}"`);
  }
  if (postingStatus && !postingStatuses.has(postingStatus)) {
    return invalidQuery(`Unsupported posting status "${postingStatus}"`);
  }
  if (environment && !environments.has(environment)) {
    return invalidQuery(`Unsupported environment "${environment}"`);
  }
  if (!dateValidation.ok) return dateValidation;

  return {
    ok: true,
    value: {
      operatorId,
      ...pagination.value,
      status: status as TransactionListInput['status'],
      postingStatus: postingStatus as TransactionListInput['postingStatus'],
      productLine: getQueryParam(url, 'product_line'),
      biller: getQueryParam(url, 'biller'),
      adapter: getQueryParam(url, 'adapter'),
      environment: environment as TransactionListInput['environment'],
      occurredFrom,
      occurredTo,
    },
  };
}

function parseIngestionErrorListQuery(
  url: URL,
  operatorId: string
): ParsedQuery<IngestionErrorListInput> {
  const pagination = parsePagination(url);
  if (!pagination.ok) return pagination;

  const errorType = getQueryParam(url, 'error_type');
  const occurredFrom = getQueryParam(url, 'occurred_from');
  const occurredTo = getQueryParam(url, 'occurred_to');
  const dateValidation = validateDateRange(occurredFrom, occurredTo);

  if (errorType && !ingestionErrorTypes.has(errorType)) {
    return invalidQuery(`Unsupported ingestion error type "${errorType}"`);
  }
  if (!dateValidation.ok) return dateValidation;

  return {
    ok: true,
    value: {
      operatorId,
      ...pagination.value,
      adapterName: getQueryParam(url, 'adapter'),
      errorType: errorType as IngestionErrorListInput['errorType'],
      sourceSystem: getQueryParam(url, 'source_system'),
      sourceId: getQueryParam(url, 'source_id'),
      occurredFrom,
      occurredTo,
    },
  };
}
