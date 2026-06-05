import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  normalize as normalizeGenericCsv,
  type GenericCsvConfig,
} from '@ledgerise/adapter-inbound-generic-csv';
import {
  normalize as normalizeGenericWebhook,
  type GenericWebhookConfig,
} from '@ledgerise/adapter-inbound-generic-webhook';
import {
  type IngestionRepository,
  type IngestionService,
  type StoredAdapterConfiguration,
  type StoredPollCursor,
  type StoredPollRun,
} from '@ledgerise/core-ingestion';

import { type AuthPrincipal, requireRole } from '../middleware/auth.js';
import { checkIngestRateLimit, INGEST_RATE_LIMIT } from '../middleware/rateLimit.js';
import { decryptConfig, encryptConfig } from '../lib/crypto.js';
import {
  getClientIp,
  getHeader,
  getNestedString,
  isRecord,
  readJsonBody,
  readMultipartFile,
  sendJson,
} from '../lib/http.js';
import { parsePagination } from '../lib/query.js';
import { findAdapter, listAdapters } from '../adapterRegistry.js';

type LogFn = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;

interface IngestRouteDeps {
  ingestionService: IngestionService;
  ingestionRepository: IngestionRepository;
  dashboardPrincipal: AuthPrincipal | null;
  getOperatorId: (request: IncomingMessage) => string;
  defaultOperatorId: string;
  log: LogFn;
}

const defaultGenericCsvConfig: GenericCsvConfig = {
  source_system: 'csv-backfill',
  environment: 'live',
  column_mappings: {
    source_id: 'reference',
    occurred_at: 'occurred_at',
    settled_at: 'settled_at',
    status: 'status',
    type: 'type',
    direction: 'direction',
    amount: 'amount',
    currency: 'currency',
    channel: 'channel',
    'principal.id': 'principal_id',
    'principal.type': 'principal_type',
    'principal.reference': 'principal_reference',
    'product.line': 'product_line',
    'product.biller': 'biller',
    'product.biller_category': 'biller_category'
  },
  metadata_columns: {
    token: 'token'
  }
};

const defaultGenericWebhookConfig: GenericWebhookConfig = {
  source_system: 'generic-api',
  environment: 'live',
  field_mappings: {
    source_id: 'txn_ref',
    occurred_at: 'paid_at',
    status: 'state',
    amount: 'value',
    type: 'service',
    direction: 'direction',
    currency: 'currency',
    channel: 'channel',
    'product.line': 'product_line',
    'product.biller': 'biller',
    'product.biller_category': 'biller_category',
    'principal.id': 'customer_id',
    'principal.reference': 'customer_phone',
    'principal.type': 'principal_type'
  },
  defaults: {
    direction: 'debit',
    currency: 'NGN',
    channel: 'api',
    'product.line': 'consumer-app',
    'principal.type': 'customer'
  },
  metadata_paths: {
    raw_service: 'service'
  },
  amount_multiplier: 100
};

const defaultAdapterConfigs: Record<string, unknown> = {
  'generic-csv': defaultGenericCsvConfig,
  'generic-webhook': defaultGenericWebhookConfig,
  'generic-poll': {
    source_system: 'generic-api',
    environment: 'live',
    url: 'https://api.example.com/transactions',
    records_path: 'data.transactions',
    cursor_query_param: 'since',
    next_cursor_record_path: 'updated_at',
    page_query_param: 'page_token',
    next_page_response_path: 'data.next_page_token',
    max_pages: 10,
    field_mappings: {
      source_id: 'id',
      occurred_at: 'created_at',
      settled_at: 'settled_at',
      amount: 'amount',
      status: 'status',
      type: 'type',
      direction: 'direction',
      currency: 'currency',
      channel: 'channel',
      'principal.id': 'customer_id',
      'principal.type': 'principal_type',
      'principal.reference': 'customer_phone',
      'product.line': 'product_line',
      'product.biller': 'biller',
      'product.biller_category': 'biller_category'
    }
  },
  'generic-journal-csv': {
    file_name_pattern: 'ledgerise-journals-{batch_id}.csv',
    amount_unit: 'major',
    include_source_transaction_id: true,
    include_mapping_rule_id: true,
    idempotency_header: 'Idempotency-Key'
  },
  'zoho-books': {
    organization_id_env: 'ZOHO_ORGANIZATION_ID',
    client_id_env: 'ZOHO_CLIENT_ID',
    journal_status: 'draft',
    batch_size: 100,
    account_map_env: 'ZOHO_ACCOUNT_MAP_JSON'
  }
};

export function toPollCursorResponse(cursor: StoredPollCursor) {
  return {
    adapter_name: cursor.adapterName,
    cursor: cursor.cursor,
    advanced_at: cursor.advancedAt,
    updated_at: cursor.updatedAt
  };
}

export function toPollRunResponse(run: StoredPollRun) {
  return {
    id: run.id,
    adapter_name: run.adapterName,
    status: run.status,
    previous_cursor: run.previousCursor,
    next_cursor: run.nextCursor,
    records_fetched: run.recordsFetched,
    accepted_count: run.acceptedCount,
    duplicate_count: run.duplicateCount,
    rejected_count: run.rejectedCount,
    error_message: run.errorMessage,
    started_at: run.startedAt,
    finished_at: run.finishedAt
  };
}

export async function handleIngestionRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: IngestRouteDeps
): Promise<boolean> {
  const { ingestionService, ingestionRepository, dashboardPrincipal, getOperatorId, defaultOperatorId, log } = deps;

  const ingestMatch = /^\/api\/ingest\/([^/]+)$/.exec(url.pathname);

  if (request.method === 'POST' && ingestMatch) {
    const remoteAddr = getClientIp(request);
    if (!checkIngestRateLimit(remoteAddr)) {
      log('warn', 'ingest_rate_limit_exceeded', { remoteAddr, path: url.pathname });
      sendJson(response, 429, {
        status: 'error',
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Ingest rate limit of ${INGEST_RATE_LIMIT} requests/minute exceeded`
      });
      return true;
    }
    const adapterName = decodeURIComponent(ingestMatch[1] ?? '');
    const adapter = findAdapter(adapterName);

    if (!adapter) {
      sendJson(response, 404, {
        status: 'error',
        code: 'ADAPTER_NOT_FOUND',
        message: `Adapter "${adapterName}" is not registered`
      });
      return true;
    }

    if (adapter.direction !== 'inbound') {
      sendJson(response, 400, {
        status: 'error',
        code: 'ADAPTER_NOT_INBOUND',
        message: `Adapter "${adapterName}" cannot ingest canonical transactions`
      });
      return true;
    }

    const body = await readJsonBody(request);

    if (!body.ok) {
      sendJson(response, 400, {
        status: 'error',
        code: 'MALFORMED_JSON',
        message: body.message
      });
      return true;
    }

    const operatorId = getHeader(request.headers['x-operator-id']) ?? defaultOperatorId;
    const normalizedRecords = await normalizeInboundPayload(ingestionRepository, adapterName, body.value, request, operatorId);

    if (normalizedRecords.status === 'error') {
      sendJson(response, 422, normalizedRecords.body);
      return true;
    }

    if (normalizedRecords.records.length !== 1) {
      sendJson(response, 400, {
        status: 'error',
        code: 'UNSUPPORTED_BATCH_INGEST',
        message: 'This ingest route expects a single canonical transaction record'
      });
      return true;
    }

    const result = await ingestionService.ingestCanonicalTransaction({
      operatorId,
      adapterName,
      record: normalizedRecords.records[0]
    });

    if (result.status === 'accepted') {
      sendJson(response, 202, {
        status: 'accepted',
        transaction_id: result.transaction.id,
        dedupe_confidence: result.transaction.dedupeConfidence
      });
      return true;
    }

    if (result.status === 'duplicate') {
      sendJson(response, 202, {
        status: 'duplicate',
        transaction_id: result.existingTransaction.id,
        marker_id: result.marker.id
      });
      return true;
    }

    sendJson(response, 422, {
      status: 'rejected',
      error_id: result.error.id,
      error_type: result.error.errorType,
      errors: result.error.validationErrors
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/adapters') {
    sendJson(response, 200, {
      records: await listConfiguredAdapters(ingestionRepository, getOperatorId(request))
    });
    return true;
  }

  const adapterConfigMatch = /^\/api\/adapters\/([^/]+)\/config$/.exec(url.pathname);
  const adapterPollStatusMatch = /^\/api\/adapters\/([^/]+)\/poll-status$/.exec(url.pathname);

  if (adapterPollStatusMatch && request.method === 'GET') {
    const adapterName = decodeURIComponent(adapterPollStatusMatch[1] ?? '');
    const adapter = findAdapter(adapterName);

    if (!adapter) {
      sendJson(response, 404, {
        status: 'error',
        code: 'ADAPTER_NOT_FOUND',
        message: 'Adapter not found'
      });
      return true;
    }

    if (adapter.direction !== 'inbound' || !adapter.modes.includes('poll')) {
      sendJson(response, 400, {
        status: 'error',
        code: 'ADAPTER_NOT_POLLABLE',
        message: `Adapter "${adapterName}" does not expose poll status`
      });
      return true;
    }

    const operatorId = getOperatorId(request);
    const pagination = parsePagination(url);

    if (!pagination.ok) {
      sendJson(response, 400, pagination.error);
      return true;
    }

    const cursor = await ingestionRepository.findPollCursor({ operatorId, adapterName });
    const runs = await ingestionRepository.listPollRuns({
      operatorId,
      adapterName,
      ...pagination.value
    });

    sendJson(response, 200, {
      adapter_name: adapterName,
      cursor: cursor ? toPollCursorResponse(cursor) : null,
      runs: runs.records.map(toPollRunResponse),
      page: runs.page
    });
    return true;
  }

  if (adapterConfigMatch && request.method === 'GET') {
    const adapterName = decodeURIComponent(adapterConfigMatch[1] ?? '');
    const adapter = findAdapter(adapterName);
    if (!adapter) {
      sendJson(response, 404, { status: 'error', code: 'ADAPTER_NOT_FOUND', message: 'Adapter not found' });
      return true;
    }

    const configuration = await getAdapterConfiguration(ingestionRepository, getOperatorId(request), adapterName);
    sendJson(response, 200, {
      record: {
        ...adapter,
        enabled: configuration?.enabled ?? true,
        config: configuration?.config ?? defaultAdapterConfigs[adapterName] ?? {}
      }
    });
    return true;
  }

  if (adapterConfigMatch && request.method === 'PATCH') {
    if (!requireRole(dashboardPrincipal!, response, ['admin'])) return true;
    const adapterName = decodeURIComponent(adapterConfigMatch[1] ?? '');
    const adapter = findAdapter(adapterName);
    if (!adapter) {
      sendJson(response, 404, { status: 'error', code: 'ADAPTER_NOT_FOUND', message: 'Adapter not found' });
      return true;
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
    }

    const payload = isRecord(body.value) ? body.value : {};
    const config = payload.config ?? {};
    const saved = await ingestionRepository.saveAdapterConfiguration({
      operatorId: getOperatorId(request),
      adapterName,
      enabled: typeof payload.enabled === 'boolean' ? payload.enabled : undefined,
      config: encryptConfig(config)
    });

    if (!saved) {
      sendJson(response, 404, {
        status: 'error',
        code: 'ADAPTER_CONFIG_NOT_FOUND',
        message: 'Adapter configuration row was not found for this operator'
      });
      return true;
    }

    sendJson(response, 200, {
      record: {
        ...adapter,
        enabled: saved.enabled,
        config: decryptConfig(saved.config)
      }
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/import/generic-csv') {
    if (!requireRole(dashboardPrincipal!, response, ['admin', 'finance'])) return true;
    const upload = await readMultipartFile(request);
    if (!upload.ok) {
      sendJson(response, 400, { status: 'error', code: 'INVALID_BODY', message: upload.message });
      return true;
    }

    const content = upload.content.toString('utf8');
    if (!content.trim()) {
      sendJson(response, 400, { status: 'error', code: 'INVALID_BODY', message: 'Uploaded file is empty' });
      return true;
    }

    const savedConfig = await getAdapterConfiguration(ingestionRepository, getOperatorId(request), 'generic-csv');
    const normalized = await normalizeGenericCsv({
      content,
      filename: upload.filename,
      config: readGenericCsvConfigFromStored(savedConfig) ?? defaultGenericCsvConfig
    });

    if (normalized.status === 'error') {
      sendJson(response, 422, normalized);
      return true;
    }

    const results = await Promise.all(
      normalized.records.map((record) =>
        ingestionService.ingestCanonicalTransaction({
          operatorId: getOperatorId(request),
          adapterName: 'generic-csv',
          record
        })
      )
    );
    const accepted = results.filter((result) => result.status === 'accepted');
    const duplicates = results.filter((result) => result.status === 'duplicate');
    const rejected = results.filter((result) => result.status === 'rejected');

    sendJson(response, 202, {
      status: 'accepted',
      imported: accepted.length,
      duplicates: duplicates.length,
      rejected: rejected.length,
      row_errors: normalized.row_errors ?? [],
      transaction_ids: accepted.map((result) =>
        result.status === 'accepted' ? result.transaction.id : ''
      ).filter(Boolean)
    });
    return true;
  }

  return false;
}

async function listConfiguredAdapters(ingestionRepository: IngestionRepository, operatorId: string) {
  const configurations = await ingestionRepository.listAdapterConfigurations(operatorId);
  const byName = new Map(configurations.map((configuration) => [configuration.name, configuration]));

  return listAdapters().map((adapter) => {
    const configuration = byName.get(adapter.name);
    return {
      ...adapter,
      enabled: configuration?.enabled ?? true,
      config: decryptConfig(configuration?.config ?? defaultAdapterConfigs[adapter.name] ?? {})
    };
  });
}

async function getAdapterConfiguration(
  ingestionRepository: IngestionRepository,
  operatorId: string,
  adapterName: string
): Promise<StoredAdapterConfiguration | null> {
  const configuration = await ingestionRepository.findAdapterConfiguration({ operatorId, adapterName });
  if (!configuration) return null;
  return { ...configuration, config: decryptConfig(configuration.config) };
}

async function normalizeInboundPayload(
  ingestionRepository: IngestionRepository,
  adapterName: string,
  payload: unknown,
  request: IncomingMessage,
  operatorId: string
): Promise<{ status: 'ok'; records: unknown[] } | { status: 'error'; body: unknown }> {
  if (adapterName !== 'generic-webhook') {
    return { status: 'ok', records: [payload] };
  }

  if (getNestedString(payload, ['source', 'adapter']) === adapterName) {
    return { status: 'ok', records: [payload] };
  }

  const savedConfig = await getAdapterConfiguration(ingestionRepository, operatorId, adapterName);
  const normalized = await normalizeGenericWebhook({
    payload,
    headers: request.headers,
    config: readGenericWebhookConfigFromStored(savedConfig) ?? defaultGenericWebhookConfig
  });

  if (normalized.status === 'error') {
    return { status: 'error', body: normalized };
  }

  return { status: 'ok', records: normalized.records };
}

function readGenericCsvConfigFromStored(
  configuration: StoredAdapterConfiguration | null
): GenericCsvConfig | undefined {
  return isRecord(configuration?.config) ? (configuration.config as unknown as GenericCsvConfig) : undefined;
}

function readGenericWebhookConfigFromStored(
  configuration: StoredAdapterConfiguration | null
): GenericWebhookConfig | undefined {
  return isRecord(configuration?.config)
    ? (configuration.config as unknown as GenericWebhookConfig)
    : undefined;
}
