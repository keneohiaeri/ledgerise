import type { IncomingMessage, ServerResponse } from 'node:http';

import pg from 'pg';

import {
  type JournalEngineService,
  type JournalEntry as EngineJournalEntry,
} from '@ledgerise/core-engine';
import {
  PostingStateError,
  type JournalLogEntry,
  type PostingService,
} from '@ledgerise/core-posting';

import { type AuthPrincipal, requireRole } from '../middleware/auth.js';
import { getSystemSettings } from '../container.js';
import {
  getHeader,
  isRecord,
  readJsonBody,
  readNumber,
  readString,
  sendJson,
} from '../lib/http.js';
import {
  getQueryParam,
  invalidQuery,
  parsePagination,
  type ParsedQuery,
} from '../lib/query.js';

type LogFn = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;

interface EngineRouteDeps {
  engineService: JournalEngineService;
  postingService: PostingService;
  pgPool: pg.Pool | null;
  dashboardPrincipal: AuthPrincipal;
  getOperatorId: (request: IncomingMessage) => string;
  log: LogFn;
}

const journalPostingStatuses = new Set([
  'generated',
  'posting',
  'posted',
  'failed',
  'unmapped',
  'retry_exhausted'
]);

export function toEngineEntryResponse(entry: EngineJournalEntry) {
  return {
    id: entry.id,
    transaction_id: entry.transactionId,
    entry_type: entry.entryType,
    status: entry.status,
    currency: entry.currency,
    amount: entry.amount,
    mapping_rule_id: entry.mappingRuleId,
    entry_order: entry.entryOrder,
    entry_label: entry.entryLabel,
    generated_at: entry.generatedAt,
    lines: entry.lines.map((line) => ({
      account_code: line.accountCode,
      side: line.side,
      amount: line.amount,
      currency: line.currency
    }))
  };
}

export function toJournalEntryResponse(entry: JournalLogEntry) {
  return {
    id: entry.id,
    transaction_id: entry.transactionId,
    entry_type: entry.entryType,
    status: entry.status,
    posting_status: entry.postingStatus,
    currency: entry.currency,
    amount: entry.amount,
    mapping_rule_id: entry.mappingRuleId,
    mapping_rule_version: entry.mappingRuleVersion,
    reversal_of_journal_entry_id: entry.reversalOfJournalEntryId,
    entry_order: entry.entryOrder,
    entry_label: entry.entryLabel,
    generated_at: entry.generatedAt,
    posted_at: entry.postedAt,
    last_posting_attempt_at: entry.lastPostingAttemptAt,
    last_posting_error: entry.lastPostingError,
    attempt_count: entry.attemptCount,
    lines: entry.lines.map((line) => ({
      account_code: line.accountCode,
      side: line.side,
      amount: line.amount,
      currency: line.currency,
      line_order: line.lineOrder
    })),
    transaction: entry.transaction
      ? {
          id: entry.transaction.id,
          source_id: entry.transaction.sourceId,
          status: entry.transaction.status,
          type: entry.transaction.type,
          occurred_at: entry.transaction.occurredAt,
          settled_at: entry.transaction.settledAt,
          source_adapter: entry.transaction.sourceAdapter,
          source_system: entry.transaction.sourceSystem,
          product_line: entry.transaction.productLine,
          product_biller: entry.transaction.productBiller,
          product_biller_category: entry.transaction.productBillerCategory
        }
      : undefined,
    attempts: entry.attempts.map((attempt) => ({
      id: attempt.id,
      adapter_name: attempt.adapterName,
      status: attempt.status,
      attempt_number: attempt.attemptNumber,
      external_reference: attempt.externalReference,
      error_code: attempt.errorCode,
      error_message: attempt.errorMessage,
      requested_by_user_id: attempt.requestedByUserId,
      occurred_at: attempt.occurredAt
    })),
    latest_attempt: entry.latestAttempt
      ? {
          id: entry.latestAttempt.id,
          adapter_name: entry.latestAttempt.adapterName,
          status: entry.latestAttempt.status,
          attempt_number: entry.latestAttempt.attemptNumber,
          external_reference: entry.latestAttempt.externalReference,
          error_code: entry.latestAttempt.errorCode,
          error_message: entry.latestAttempt.errorMessage,
          requested_by_user_id: entry.latestAttempt.requestedByUserId,
          occurred_at: entry.latestAttempt.occurredAt
        }
      : undefined
  };
}

export async function handleEngineRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: EngineRouteDeps
): Promise<boolean> {
  const { engineService, postingService, pgPool, dashboardPrincipal, getOperatorId, log } = deps;

  if (request.method === 'GET' && url.pathname === '/api/journal-entries/stats') {
    if (!requireRole(dashboardPrincipal, response, ['admin', 'finance', 'auditor'])) return true;
    const operatorId = getOperatorId(request);
    const result = pgPool
      ? await pgPool.query<{ posting_status: string; count: string }>(
          `SELECT posting_status, COUNT(*)::text AS count
           FROM journal_entries WHERE operator_id = $1
           GROUP BY posting_status`,
          [operatorId]
        )
      : { rows: [] };
    const counts: Record<string, number> = {};
    for (const row of result.rows) counts[row.posting_status] = Number(row.count);
    sendJson(response, 200, { stats: counts });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/journal-entries') {
    const operatorId = getOperatorId(request);
    const filters = parseJournalEntryListQuery(url, operatorId);
    if (!filters.ok) {
      sendJson(response, 400, filters.error);
      return true;
    }
    const journalEntries = await postingService.listJournalEntries(filters.value);
    sendJson(response, 200, {
      records: journalEntries.records.map(toJournalEntryResponse),
      page: journalEntries.page
    });
    return true;
  }

  const journalEntryMatch = /^\/api\/journal-entries\/([^/]+)$/.exec(url.pathname);

  if (request.method === 'GET' && journalEntryMatch) {
    const journalEntryId = decodeURIComponent(journalEntryMatch[1] ?? '');
    const journalEntry = await postingService.findJournalEntry({
      operatorId: getOperatorId(request),
      journalEntryId
    });
    if (!journalEntry) {
      sendJson(response, 404, {
        status: 'error',
        code: 'JOURNAL_ENTRY_NOT_FOUND',
        message: `Journal entry "${journalEntryId}" was not found`
      });
      return true;
    }
    sendJson(response, 200, { record: toJournalEntryResponse(journalEntry) });
    return true;
  }

  const journalEntryRetryMatch = /^\/api\/journal-entries\/([^/]+)\/retry$/.exec(url.pathname);

  if (request.method === 'POST' && journalEntryRetryMatch) {
    if (!requireRole(dashboardPrincipal, response, ['admin', 'finance'])) return true;
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
    }
    const journalEntryId = decodeURIComponent(journalEntryRetryMatch[1] ?? '');
    const retryInput = isRecord(body.value) ? body.value : {};
    try {
      const journalEntry = await postingService.requestManualRetry({
        operatorId: getOperatorId(request),
        journalEntryId,
        adapterName: readString(retryInput, 'adapter_name') ?? 'generic-journal-csv',
        requestedByUserId: getHeader(request.headers['x-user-id'])
      });
      if (!journalEntry) {
        sendJson(response, 404, {
          status: 'error',
          code: 'JOURNAL_ENTRY_NOT_FOUND',
          message: `Journal entry "${journalEntryId}" was not found`
        });
        return true;
      }
      sendJson(response, 200, { record: toJournalEntryResponse(journalEntry) });
    } catch (error) {
      if (error instanceof PostingStateError) {
        sendJson(response, 409, {
          status: 'error',
          code: error.code,
          message: error.message
        });
        return true;
      }
      throw error;
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/engine/run') {
    if (!requireRole(dashboardPrincipal, response, ['admin', 'finance'])) return true;
    const body = await readJsonBody(request);
    const payload = body.ok && isRecord(body.value) ? body.value : {};
    const limit = readNumber(payload, 'limit');
    const settings = getSystemSettings(getOperatorId(request));
    const result = await engineService.runOnce({
      operatorId: getOperatorId(request),
      limit: (Number.isInteger(limit) && limit! > 0 ? limit : undefined) ?? settings.batchSize,
      suspenseAccountCode: settings.suspenseAccountCode
    });
    log('info', 'engine_run', {
      operatorId: getOperatorId(request),
      scanned: result.scanned,
      generated: result.generated,
      skipped: result.skipped.length
    });
    sendJson(response, 200, {
      scanned: result.scanned,
      generated: result.generated,
      skipped: result.skipped.length,
      entries: result.entries.map(toEngineEntryResponse)
    });
    return true;
  }

  return false;
}

function parseJournalEntryListQuery(
  url: URL,
  operatorId: string
): ParsedQuery<{
  operatorId: string;
  limit: number;
  offset: number;
  postingStatus?: JournalLogEntry['postingStatus'];
}> {
  const pagination = parsePagination(url);
  if (!pagination.ok) return pagination;

  const postingStatus = getQueryParam(url, 'posting_status');
  if (postingStatus && !journalPostingStatuses.has(postingStatus)) {
    return invalidQuery(`Unsupported journal posting status "${postingStatus}"`);
  }

  return {
    ok: true,
    value: {
      operatorId,
      ...pagination.value,
      postingStatus: postingStatus as JournalLogEntry['postingStatus']
    }
  };
}
