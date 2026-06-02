import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  normalize as normalizeGenericCsv,
  type GenericCsvConfig
} from '@ledgerise/adapter-inbound-generic-csv';
import {
  normalize as normalizeGenericWebhook,
  type GenericWebhookConfig
} from '@ledgerise/adapter-inbound-generic-webhook';
import {
  postJournals as postGenericJournalCsv,
  validate as validateGenericJournalCsv
} from '@ledgerise/adapter-outbound-generic-journal-csv';
import {
  postJournals as postZohoBooksJournals,
  validate as validateZohoBooksJournals
} from '@ledgerise/adapter-outbound-zoho-books';
import {
  IngestionService,
  InMemoryIngestionRepository,
  type IngestionErrorListInput,
  type IngestionRepository,
  type StoredAdapterConfiguration,
  type StoredCanonicalTransaction,
  type StoredIngestionError,
  type TransactionListInput
} from '@ledgerise/core-ingestion';
import { PostgresIngestionRepository } from '@ledgerise/core-ingestion/postgres';
import {
  InMemoryMappingRepository,
  MappingService,
  MappingValidationError,
  type MappingRepository,
  type NewMappingRule,
  type UpdateMappingRule
} from '@ledgerise/core-mapping';
import { PostgresMappingRepository } from '@ledgerise/core-mapping/postgres';
import {
  InMemoryPostingRepository,
  PostingService,
  PostingStateError,
  type ApiKeyPrincipal,
  type ApiScope,
  type JournalLogEntry,
  type PostingBatch,
  type PostingArtifact,
  type PostingRepository
} from '@ledgerise/core-posting';
import { PostgresPostingRepository } from '@ledgerise/core-posting/postgres';

import { findAdapter, listAdapters } from './adapterRegistry.js';

const port = Number(process.env.API_PORT ?? '3000');

const { ingestionRepository, mappingRepository, postingRepository, defaultOperatorId, repositoryKind } =
  await createRepositories();
const ingestionService = new IngestionService(ingestionRepository);
const mappingService = new MappingService(mappingRepository);
const postingService = new PostingService(postingRepository);

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
    endpoint_url: 'https://api.example.com/transactions',
    auth_header: 'Authorization',
    records_path: 'data.transactions',
    poll_interval: 'Every 15 minutes',
    cursor_field: 'updated_at'
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

const server = createServer(async (request, response) => {
  applyCors(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/healthcheck') {
    sendJson(response, 200, {
      status: 'ok',
      service: 'ledgerise-api',
      repository: repositoryKind
    });
    return;
  }

  const ingestMatch = /^\/api\/ingest\/([^/]+)$/.exec(url.pathname);

  if (request.method === 'POST' && ingestMatch) {
    const adapterName = decodeURIComponent(ingestMatch[1] ?? '');
    const adapter = findAdapter(adapterName);

    if (!adapter) {
      sendJson(response, 404, {
        status: 'error',
        code: 'ADAPTER_NOT_FOUND',
        message: `Adapter "${adapterName}" is not registered`
      });
      return;
    }

    if (adapter.direction !== 'inbound') {
      sendJson(response, 400, {
        status: 'error',
        code: 'ADAPTER_NOT_INBOUND',
        message: `Adapter "${adapterName}" cannot ingest canonical transactions`
      });
      return;
    }

    const body = await readJsonBody(request);

    if (!body.ok) {
      sendJson(response, 400, {
        status: 'error',
        code: 'MALFORMED_JSON',
        message: body.message
      });
      return;
    }

    const operatorId = getHeader(request.headers['x-operator-id']) ?? defaultOperatorId;
    const normalizedRecords = await normalizeInboundPayload(adapterName, body.value, request, operatorId);

    if (normalizedRecords.status === 'error') {
      sendJson(response, 422, normalizedRecords.body);
      return;
    }

    if (normalizedRecords.records.length !== 1) {
      sendJson(response, 400, {
        status: 'error',
        code: 'UNSUPPORTED_BATCH_INGEST',
        message: 'This ingest route expects a single canonical transaction record'
      });
      return;
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
      return;
    }

    if (result.status === 'duplicate') {
      sendJson(response, 202, {
        status: 'duplicate',
        transaction_id: result.existingTransaction.id,
        marker_id: result.marker.id
      });
      return;
    }

    sendJson(response, 422, {
      status: 'rejected',
      error_id: result.error.id,
      error_type: result.error.errorType,
      errors: result.error.validationErrors
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/adapters') {
    sendJson(response, 200, {
      records: await listConfiguredAdapters(getOperatorId(request))
    });
    return;
  }

  const adapterConfigMatch = /^\/api\/adapters\/([^/]+)\/config$/.exec(url.pathname);

  if (adapterConfigMatch && request.method === 'GET') {
    const adapterName = decodeURIComponent(adapterConfigMatch[1] ?? '');
    const adapter = findAdapter(adapterName);
    if (!adapter) {
      sendJson(response, 404, { status: 'error', code: 'ADAPTER_NOT_FOUND', message: 'Adapter not found' });
      return;
    }

    const configuration = await getAdapterConfiguration(getOperatorId(request), adapterName);
    sendJson(response, 200, {
      record: {
        ...adapter,
        enabled: configuration?.enabled ?? true,
        config: configuration?.config ?? defaultAdapterConfigs[adapterName] ?? {}
      }
    });
    return;
  }

  if (adapterConfigMatch && request.method === 'PATCH') {
    const adapterName = decodeURIComponent(adapterConfigMatch[1] ?? '');
    const adapter = findAdapter(adapterName);
    if (!adapter) {
      sendJson(response, 404, { status: 'error', code: 'ADAPTER_NOT_FOUND', message: 'Adapter not found' });
      return;
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }

    const payload = isRecord(body.value) ? body.value : {};
    const config = payload.config ?? {};
    const saved = await ingestionRepository.saveAdapterConfiguration({
      operatorId: getOperatorId(request),
      adapterName,
      enabled: typeof payload.enabled === 'boolean' ? payload.enabled : undefined,
      config
    });

    if (!saved) {
      sendJson(response, 404, {
        status: 'error',
        code: 'ADAPTER_CONFIG_NOT_FOUND',
        message: 'Adapter configuration row was not found for this operator'
      });
      return;
    }

    sendJson(response, 200, {
      record: {
        ...adapter,
        enabled: saved.enabled,
        config: saved.config
      }
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/import/generic-csv') {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }

    const payload = isRecord(body.value) ? body.value : {};
    const content = readString(payload, 'content');
    if (!content) {
      sendJson(response, 400, {
        status: 'error',
        code: 'INVALID_BODY',
        message: 'Body must include CSV content'
      });
      return;
    }

    const savedConfig = await getAdapterConfiguration(getOperatorId(request), 'generic-csv');
    const normalized = await normalizeGenericCsv({
      content,
      filename: readString(payload, 'filename'),
      config: readGenericCsvConfig(payload) ?? readGenericCsvConfigFromStored(savedConfig) ?? defaultGenericCsvConfig
    });

    if (normalized.status === 'error') {
      sendJson(response, 422, normalized);
      return;
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
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/transactions') {
    const operatorId = getOperatorId(request);
    const filters = parseTransactionListQuery(url, operatorId);

    if (!filters.ok) {
      sendJson(response, 400, filters.error);
      return;
    }

    const transactions = await ingestionRepository.listTransactions(filters.value);

    sendJson(response, 200, {
      records: transactions.records.map(toTransactionSummary),
      page: transactions.page
    });
    return;
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
        message: `Transaction "${transactionId}" was not found`
      });
      return;
    }

    sendJson(response, 200, {
      record: toTransactionDetail(transaction)
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/ingestion-errors') {
    const operatorId = getOperatorId(request);
    const filters = parseIngestionErrorListQuery(url, operatorId);

    if (!filters.ok) {
      sendJson(response, 400, filters.error);
      return;
    }

    const ingestionErrors = await ingestionRepository.listIngestionErrors(filters.value);

    sendJson(response, 200, {
      records: ingestionErrors.records.map(toIngestionErrorResponse),
      page: ingestionErrors.page
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/journal-entries') {
    const operatorId = getOperatorId(request);
    const filters = parseJournalEntryListQuery(url, operatorId);

    if (!filters.ok) {
      sendJson(response, 400, filters.error);
      return;
    }

    const journalEntries = await postingService.listJournalEntries(filters.value);
    sendJson(response, 200, {
      records: journalEntries.records.map(toJournalEntryResponse),
      page: journalEntries.page
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/posting-batches/generic-journal-csv') {
    const auth = await authenticatePostingRequest(request, response, 'posting_batches:create');
    if (!auth) return;

    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }

    const payload = isRecord(body.value) ? body.value : {};
    const rawLimit = readNumber(payload, 'limit');
    const limit = rawLimit === undefined ? 100 : rawLimit;

    try {
      const batch = await postingService.createPostingBatch({
        operatorId: auth.operatorId,
        adapterName: 'generic-journal-csv',
        journalEntryIds: readStringArray(payload, 'journal_entry_ids') ?? readStringArray(payload, 'journalEntryIds'),
        idempotencyKey:
          getHeader(request.headers['idempotency-key']) ??
          readString(payload, 'idempotency_key') ??
          readString(payload, 'idempotencyKey'),
        createdByApiKeyId: auth.id,
        limit
      });

      if (batch.replayed) {
        const existingArtifact = await postingService.findPostingArtifactByBatchId({
          operatorId: auth.operatorId,
          batchId: batch.id
        });
        if (!existingArtifact && batch.status === 'posting') {
          sendJson(response, 409, {
            status: 'error',
            code: 'POSTING_BATCH_IN_PROGRESS',
            message: 'A posting batch with this idempotency key is still in progress',
            batch: toPostingBatchResponse(batch)
          });
          return;
        }
        sendJson(response, 200, {
          status: batch.status,
          replayed: true,
          batch: toPostingBatchResponse(batch, existingArtifact ?? undefined),
          artifact: existingArtifact ? toPostingArtifactResponse(existingArtifact, true) : undefined
        });
        return;
      }

      const outboundBatch = toOutboundJournalBatch(batch);
      const validation = validateGenericJournalCsv(outboundBatch);

      if (!validation.valid) {
        const completed = await postingService.completePostingBatch({
          operatorId: auth.operatorId,
          batchId: batch.id,
          adapterName: 'generic-journal-csv',
          results: batch.entries.map((entry) => ({
            journalEntryId: entry.id,
            status: 'failed',
            errorCode: 'VALIDATION_FAILED',
            errorMessage: validation.errors.map((error) => `${error.field}: ${error.message}`).join('; ')
          }))
        });
        sendJson(response, 422, {
          status: 'error',
          code: 'VALIDATION_FAILED',
          batch: completed ? toPostingBatchResponse(completed) : undefined,
          errors: validation.errors
        });
        return;
      }

      const adapterResult = await postGenericJournalCsv(outboundBatch);
      const completed = await postingService.completePostingBatch({
        operatorId: auth.operatorId,
        batchId: batch.id,
        adapterName: 'generic-journal-csv',
        results: [
          ...adapterResult.posted.map((result) => ({
            journalEntryId: result.journal_entry_id,
            status: 'posted' as const,
            externalReference: result.external_reference
          })),
          ...adapterResult.failed.map((result) => ({
            journalEntryId: result.journal_entry_id,
            status: 'failed' as const,
            errorCode: result.code,
            errorMessage: result.message
          }))
        ]
      });
      const artifact = adapterResult.artifact
        ? await postingService.savePostingArtifact({
            operatorId: auth.operatorId,
            postingBatchId: batch.id,
            contentType: adapterResult.artifact.content_type,
            filename: adapterResult.artifact.filename,
            content: adapterResult.artifact.content,
            checksumSha256: sha256(adapterResult.artifact.content),
            sizeBytes: Buffer.byteLength(adapterResult.artifact.content, 'utf8'),
            rowCount: countCsvRows(adapterResult.artifact.content),
            createdByApiKeyId: auth.id
          })
        : undefined;

      sendJson(response, adapterResult.status === 'ok' ? 201 : 207, {
        status: adapterResult.status,
        replayed: false,
        batch: completed ? toPostingBatchResponse(completed, artifact) : undefined,
        posted: adapterResult.posted,
        failed: adapterResult.failed,
        artifact: artifact ? toPostingArtifactResponse(artifact, true) : undefined
      });
    } catch (error) {
      if (error instanceof PostingStateError) {
        sendJson(response, error.code === 'NO_POSTABLE_JOURNALS' ? 409 : 400, {
          status: 'error',
          code: error.code,
          message: error.message
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/posting-batches/zoho-books') {
    const auth = await authenticatePostingRequest(request, response, 'posting_batches:create');
    if (!auth) return;

    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }

    const payload = isRecord(body.value) ? body.value : {};
    const rawLimit = readNumber(payload, 'limit');
    const limit = rawLimit === undefined ? 100 : rawLimit;

    try {
      const batch = await postingService.createPostingBatch({
        operatorId: auth.operatorId,
        adapterName: 'zoho-books',
        journalEntryIds: readStringArray(payload, 'journal_entry_ids') ?? readStringArray(payload, 'journalEntryIds'),
        idempotencyKey:
          getHeader(request.headers['idempotency-key']) ??
          readString(payload, 'idempotency_key') ??
          readString(payload, 'idempotencyKey'),
        createdByApiKeyId: auth.id,
        limit
      });

      if (batch.replayed) {
        sendJson(response, 200, {
          status: batch.status,
          replayed: true,
          batch: toPostingBatchResponse(batch)
        });
        return;
      }

      const outboundBatch = toOutboundJournalBatch(batch);
      const validation = validateZohoBooksJournals(outboundBatch);

      if (!validation.valid) {
        const completed = await postingService.completePostingBatch({
          operatorId: auth.operatorId,
          batchId: batch.id,
          adapterName: 'zoho-books',
          results: batch.entries.map((entry) => ({
            journalEntryId: entry.id,
            status: 'failed',
            errorCode: 'VALIDATION_FAILED',
            errorMessage: validation.errors.map((error) => `${error.field}: ${error.message}`).join('; ')
          }))
        });
        sendJson(response, 422, {
          status: 'error',
          code: 'VALIDATION_FAILED',
          batch: completed ? toPostingBatchResponse(completed) : undefined,
          errors: validation.errors
        });
        return;
      }

      const adapterResult = await postZohoBooksJournals(outboundBatch);
      const completed = await postingService.completePostingBatch({
        operatorId: auth.operatorId,
        batchId: batch.id,
        adapterName: 'zoho-books',
        results: [
          ...adapterResult.posted.map((result) => ({
            journalEntryId: result.journal_entry_id,
            status: 'posted' as const,
            externalReference: result.external_reference
          })),
          ...adapterResult.failed.map((result) => ({
            journalEntryId: result.journal_entry_id,
            status: 'failed' as const,
            errorCode: result.code,
            errorMessage: result.message
          }))
        ]
      });

      sendJson(response, adapterResult.status === 'ok' ? 201 : 207, {
        status: adapterResult.status,
        replayed: false,
        batch: completed ? toPostingBatchResponse(completed) : undefined,
        posted: adapterResult.posted,
        failed: adapterResult.failed
      });
    } catch (error) {
      if (error instanceof PostingStateError) {
        sendJson(response, error.code === 'NO_POSTABLE_JOURNALS' ? 409 : 400, {
          status: 'error',
          code: error.code,
          message: error.message
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/posting-batches') {
    const auth = await authenticatePostingRequest(request, response, 'posting_batches:read');
    if (!auth) return;

    const pagination = parsePagination(url);
    if (!pagination.ok) {
      sendJson(response, 400, pagination.error);
      return;
    }

    const batches = await postingService.listPostingBatches({
      operatorId: auth.operatorId,
      ...pagination.value
    });
    const records = await Promise.all(
      batches.records.map(async (batch) => {
        const artifact = await postingService.findPostingArtifactByBatchId({
          operatorId: auth.operatorId,
          batchId: batch.id
        });
        return toPostingBatchResponse(batch, artifact ?? undefined);
      })
    );

    sendJson(response, 200, {
      records,
      page: batches.page
    });
    return;
  }

  const postingBatchArtifactMatch = /^\/api\/posting-batches\/([^/]+)\/artifact\.csv$/.exec(
    url.pathname
  );

  if (request.method === 'GET' && postingBatchArtifactMatch) {
    const auth = await authenticatePostingRequest(request, response, 'posting_artifacts:download');
    if (!auth) return;

    const batchId = decodeURIComponent(postingBatchArtifactMatch[1] ?? '');
    const artifact = await postingService.findPostingArtifactByBatchId({
      operatorId: auth.operatorId,
      batchId
    });
    if (!artifact) {
      sendJson(response, 404, {
        status: 'error',
        code: 'POSTING_ARTIFACT_NOT_FOUND',
        message: `Posting artifact for batch "${batchId}" was not found`
      });
      return;
    }

    await postingService.recordPostingArtifactDownload({
      operatorId: auth.operatorId,
      postingArtifactId: artifact.id,
      postingBatchId: artifact.postingBatchId,
      apiKeyId: auth.id,
      userAgent: getHeader(request.headers['user-agent']),
      remoteAddr: request.socket.remoteAddress
    });

    sendText(response, 200, artifact.content, {
      'content-type': artifact.contentType,
      'content-disposition': `attachment; filename="${artifact.filename}"`,
      'x-ledgerise-posting-batch-id': artifact.postingBatchId,
      'x-ledgerise-artifact-checksum-sha256': artifact.checksumSha256
    });
    return;
  }

  const postingBatchMatch = /^\/api\/posting-batches\/([^/]+)$/.exec(url.pathname);

  if (request.method === 'GET' && postingBatchMatch) {
    const auth = await authenticatePostingRequest(request, response, 'posting_batches:read');
    if (!auth) return;

    const batchId = decodeURIComponent(postingBatchMatch[1] ?? '');
    const batch = await postingService.findPostingBatch({
      operatorId: auth.operatorId,
      batchId
    });
    if (!batch) {
      sendJson(response, 404, {
        status: 'error',
        code: 'POSTING_BATCH_NOT_FOUND',
        message: `Posting batch "${batchId}" was not found`
      });
      return;
    }
    const artifact = await postingService.findPostingArtifactByBatchId({
      operatorId: auth.operatorId,
      batchId
    });

    sendJson(response, 200, {
      record: toPostingBatchResponse(batch, artifact ?? undefined)
    });
    return;
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
      return;
    }

    sendJson(response, 200, { record: toJournalEntryResponse(journalEntry) });
    return;
  }

  const journalEntryRetryMatch = /^\/api\/journal-entries\/([^/]+)\/retry$/.exec(url.pathname);

  if (request.method === 'POST' && journalEntryRetryMatch) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
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
        return;
      }

      sendJson(response, 200, { record: toJournalEntryResponse(journalEntry) });
    } catch (error) {
      if (error instanceof PostingStateError) {
        sendJson(response, 409, {
          status: 'error',
          code: error.code,
          message: error.message
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/coa') {
    sendJson(response, 200, {
      records: await mappingService.listChartAccounts(getOperatorId(request))
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/coa/import') {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }
    const accounts = isRecord(body.value) ? body.value.accounts : undefined;
    if (!Array.isArray(accounts)) {
      sendJson(response, 400, {
        status: 'error',
        code: 'INVALID_BODY',
        message: 'Body must include accounts array'
      });
      return;
    }
    const result = await handleMappingRequest(response, () =>
      mappingService.importChartAccounts(getOperatorId(request), accounts)
    );
    if (result) sendJson(response, 200, { records: result });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/mapping-rules') {
    sendJson(response, 200, {
      records: await mappingService.listMappingRules(getOperatorId(request))
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/mapping-rules') {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }
    const result = await handleMappingRequest(response, () =>
      mappingService.createMappingRule(getOperatorId(request), toMappingRuleInput(body.value))
    );
    if (result) sendJson(response, 201, { record: result });
    return;
  }

  const mappingRuleMatch = /^\/api\/mapping-rules\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'PATCH' && mappingRuleMatch) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }
    const ruleId = decodeURIComponent(mappingRuleMatch[1] ?? '');
    const result = await handleMappingRequest(response, () =>
      mappingService.updateMappingRule(getOperatorId(request), ruleId, toMappingRuleUpdateInput(body.value))
    );
    if (result === null) {
      sendJson(response, 404, { status: 'error', code: 'MAPPING_RULE_NOT_FOUND', message: 'Mapping rule not found' });
    } else if (result) {
      sendJson(response, 200, { record: result });
    }
    return;
  }

  const mappingRuleStatusMatch = /^\/api\/mapping-rules\/([^/]+)\/(activate|deactivate)$/.exec(
    url.pathname
  );
  if (request.method === 'POST' && mappingRuleStatusMatch) {
    const ruleId = decodeURIComponent(mappingRuleStatusMatch[1] ?? '');
    const status = mappingRuleStatusMatch[2] === 'activate' ? 'active' : 'inactive';
    const result = await mappingService.setMappingRuleStatus(getOperatorId(request), ruleId, status);
    if (!result) {
      sendJson(response, 404, { status: 'error', code: 'MAPPING_RULE_NOT_FOUND', message: 'Mapping rule not found' });
      return;
    }
    sendJson(response, 200, { record: result });
    return;
  }

  sendJson(response, 404, {
    status: 'error',
    code: 'NOT_FOUND',
    message: 'Route not found'
  });
});

server.listen(port, () => {
  console.log(`Ledgerise API listening on port ${port} using ${repositoryKind} ingestion storage.`);
});

async function createRepositories(): Promise<{
  ingestionRepository: IngestionRepository;
  mappingRepository: MappingRepository;
  postingRepository: PostingRepository;
  defaultOperatorId: string;
  repositoryKind: 'memory' | 'postgres';
}> {
  if (!process.env.DATABASE_URL) {
    return {
      ingestionRepository: new InMemoryIngestionRepository(),
      mappingRepository: new InMemoryMappingRepository(),
      postingRepository: new InMemoryPostingRepository(),
      defaultOperatorId: process.env.DEFAULT_OPERATOR_ID ?? 'local-operator',
      repositoryKind: 'memory'
    };
  }

  const ingestionRepository = new PostgresIngestionRepository({
    connectionString: process.env.DATABASE_URL
  });
  const mappingRepository = new PostgresMappingRepository({
    connectionString: process.env.DATABASE_URL
  });
  const postingRepository = new PostgresPostingRepository({
    connectionString: process.env.DATABASE_URL
  });
  const defaultOperatorId =
    process.env.DEFAULT_OPERATOR_ID ??
    (await ingestionRepository.findOperatorIdBySlug(process.env.DEFAULT_OPERATOR_SLUG ?? 'local-operator'));

  if (!defaultOperatorId) {
    throw new Error(
      'No default operator found. Set DEFAULT_OPERATOR_ID or run infra/seed/0001_local_operator_and_adapters.sql.'
    );
  }

  return {
    ingestionRepository,
    mappingRepository,
    postingRepository,
    defaultOperatorId,
    repositoryKind: 'postgres'
  };
}

async function readJsonBody(
  request: IncomingMessage
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks).toString('utf8'))
    };
  } catch {
    return {
      ok: false,
      message: 'Request body must be valid JSON'
    };
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
) {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*'
  });
  response.end(JSON.stringify(body));
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  headers: Record<string, string> = {}
) {
  response.writeHead(statusCode, {
    'access-control-allow-origin': '*',
    ...headers
  });
  response.end(body);
}

async function listConfiguredAdapters(operatorId: string) {
  const configurations = await ingestionRepository.listAdapterConfigurations(operatorId);
  const byName = new Map(configurations.map((configuration) => [configuration.name, configuration]));

  return listAdapters().map((adapter) => {
    const configuration = byName.get(adapter.name);
    return {
      ...adapter,
      enabled: configuration?.enabled ?? true,
      config: configuration?.config ?? defaultAdapterConfigs[adapter.name] ?? {}
    };
  });
}

async function getAdapterConfiguration(
  operatorId: string,
  adapterName: string
): Promise<StoredAdapterConfiguration | null> {
  return ingestionRepository.findAdapterConfiguration({ operatorId, adapterName });
}

async function normalizeInboundPayload(
  adapterName: string,
  payload: unknown,
  request: IncomingMessage,
  operatorId: string
): Promise<{ status: 'ok'; records: unknown[] } | { status: 'error'; body: unknown }> {
  if (adapterName !== 'generic-webhook') {
    return { status: 'ok', records: [payload] };
  }

  const savedConfig = await getAdapterConfiguration(operatorId, adapterName);
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

function applyCors(response: ServerResponse) {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
  response.setHeader(
    'access-control-allow-headers',
    'authorization,content-type,idempotency-key,x-api-key,x-operator-id,x-user-id'
  );
}

function getHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getOperatorId(request: IncomingMessage): string {
  return getHeader(request.headers['x-operator-id']) ?? defaultOperatorId;
}

async function authenticatePostingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requiredScope: ApiScope
): Promise<ApiKeyPrincipal | null> {
  const rawKey = readApiKey(request);
  if (!rawKey) {
    sendJson(response, 401, {
      status: 'error',
      code: 'API_KEY_REQUIRED',
      message: 'Provide an API key using Authorization: Bearer <key> or x-api-key'
    });
    return null;
  }

  const principal = await postingService.authenticateApiKey({
    keyHash: sha256(rawKey),
    requiredScope
  });
  if (!principal) {
    sendJson(response, 403, {
      status: 'error',
      code: 'API_KEY_FORBIDDEN',
      message: `API key is invalid, expired, disabled, or missing scope "${requiredScope}"`
    });
    return null;
  }

  return principal;
}

function readApiKey(request: IncomingMessage): string | undefined {
  const authorization = getHeader(request.headers.authorization);
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim() || undefined;
  }
  return getHeader(request.headers['x-api-key']);
}

function toTransactionSummary(transaction: StoredCanonicalTransaction) {
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
    ingested_at: transaction.ingestedAt
  };
}

function toTransactionDetail(transaction: StoredCanonicalTransaction) {
  return {
    ...toTransactionSummary(transaction),
    canonical_record: transaction.record
  };
}

function toIngestionErrorResponse(error: StoredIngestionError) {
  return {
    id: error.id,
    adapter_name: error.adapterName,
    error_type: error.errorType,
    source_system: error.sourceSystem,
    source_id: error.sourceId,
    existing_transaction_id: error.existingTransactionId,
    validation_errors: error.validationErrors,
    raw_record: error.rawRecord,
    occurred_at: error.occurredAt
  };
}

function toJournalEntryResponse(entry: JournalLogEntry) {
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

function toPostingBatchResponse(batch: PostingBatch, artifact?: PostingArtifact) {
  return {
    id: batch.id,
    adapter_name: batch.adapterName,
    status: batch.status,
    journal_entry_count: batch.journalEntryCount,
    idempotency_key: batch.idempotencyKey,
    created_at: batch.createdAt,
    updated_at: batch.updatedAt,
    entries: batch.entries.map(toJournalEntryResponse),
    artifact: artifact ? toPostingArtifactResponse(artifact, false) : undefined
  };
}

function toPostingArtifactResponse(artifact: PostingArtifact, includeContent: boolean) {
  return {
    id: artifact.id,
    posting_batch_id: artifact.postingBatchId,
    content_type: artifact.contentType,
    filename: artifact.filename,
    checksum_sha256: artifact.checksumSha256,
    size_bytes: artifact.sizeBytes,
    row_count: artifact.rowCount,
    created_at: artifact.createdAt,
    ...(includeContent ? { content: artifact.content } : {})
  };
}

function toOutboundJournalBatch(batch: PostingBatch) {
  return {
    id: batch.id,
    operator_id: batch.operatorId,
    adapter_name: batch.adapterName,
    created_at: batch.createdAt,
    entries: batch.entries.map((entry) => ({
      id: entry.id,
      transaction_id: entry.transactionId,
      source_id: entry.transaction?.sourceId,
      transaction_type: entry.transaction?.type,
      product_line: entry.transaction?.productLine,
      product_biller: entry.transaction?.productBiller,
      entry_type: entry.entryType,
      currency: entry.currency,
      amount: entry.amount,
      generated_at: entry.generatedAt,
      mapping_rule_id: entry.mappingRuleId,
      mapping_rule_version: entry.mappingRuleVersion,
      lines: entry.lines.map((line) => ({
        account_code: line.accountCode,
        side: line.side,
        amount: line.amount,
        currency: line.currency,
        line_order: line.lineOrder
      }))
    }))
  };
}

type ParsedQuery<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: {
        status: 'error';
        code: string;
        message: string;
      };
    };

const transactionStatuses = new Set(['pending', 'settled', 'failed', 'reversed', 'disputed']);
const postingStatuses = new Set(['unposted']);
const journalPostingStatuses = new Set([
  'generated',
  'posting',
  'posted',
  'failed',
  'unmapped',
  'retry_exhausted'
]);
const environments = new Set(['live', 'test']);
const ingestionErrorTypes = new Set([
  'schema_validation',
  'adapter_mismatch',
  'duplicate_source'
]);

function parseTransactionListQuery(
  url: URL,
  operatorId: string
): ParsedQuery<TransactionListInput> {
  const pagination = parsePagination(url);

  if (!pagination.ok) {
    return pagination;
  }

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

  if (!dateValidation.ok) {
    return dateValidation;
  }

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
      occurredTo
    }
  };
}

function parseIngestionErrorListQuery(
  url: URL,
  operatorId: string
): ParsedQuery<IngestionErrorListInput> {
  const pagination = parsePagination(url);

  if (!pagination.ok) {
    return pagination;
  }

  const errorType = getQueryParam(url, 'error_type');
  const occurredFrom = getQueryParam(url, 'occurred_from');
  const occurredTo = getQueryParam(url, 'occurred_to');
  const dateValidation = validateDateRange(occurredFrom, occurredTo);

  if (errorType && !ingestionErrorTypes.has(errorType)) {
    return invalidQuery(`Unsupported ingestion error type "${errorType}"`);
  }

  if (!dateValidation.ok) {
    return dateValidation;
  }

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
      occurredTo
    }
  };
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

  if (!pagination.ok) {
    return pagination;
  }

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

function parsePagination(url: URL): ParsedQuery<{ limit: number; offset: number }> {
  const limit = getIntegerQueryParam(url, 'limit', 100);
  const offset = getIntegerQueryParam(url, 'offset', 0);

  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return invalidQuery('Query parameter "limit" must be an integer from 1 to 500');
  }

  if (!Number.isInteger(offset) || offset < 0) {
    return invalidQuery('Query parameter "offset" must be an integer greater than or equal to 0');
  }

  return {
    ok: true,
    value: {
      limit,
      offset
    }
  };
}

function validateDateRange(
  occurredFrom: string | undefined,
  occurredTo: string | undefined
): ParsedQuery<undefined> {
  if (occurredFrom && Number.isNaN(Date.parse(occurredFrom))) {
    return invalidQuery('Query parameter "occurred_from" must be an ISO 8601 timestamp');
  }

  if (occurredTo && Number.isNaN(Date.parse(occurredTo))) {
    return invalidQuery('Query parameter "occurred_to" must be an ISO 8601 timestamp');
  }

  if (occurredFrom && occurredTo && occurredFrom > occurredTo) {
    return invalidQuery('"occurred_from" must be before or equal to "occurred_to"');
  }

  return {
    ok: true,
    value: undefined
  };
}

function getIntegerQueryParam(url: URL, name: string, fallback: number): number {
  const value = getQueryParam(url, name);
  return value ? Number(value) : fallback;
}

function getQueryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value?.trim() || undefined;
}

function invalidQuery(message: string): ParsedQuery<never> {
  return {
    ok: false,
    error: {
      status: 'error',
      code: 'INVALID_QUERY',
      message
    }
  };
}

async function handleMappingRequest<T>(
  response: ServerResponse,
  operation: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MappingValidationError) {
      sendJson(response, 400, {
        status: 'error',
        code: 'VALIDATION_FAILED',
        errors: error.errors
      });
      return undefined;
    }

    throw error;
  }
}

function toMappingRuleInput(input: unknown): NewMappingRule {
  if (!isRecord(input)) {
    throw new MappingValidationError(['Body must be an object']);
  }

  return {
    productLine: readString(input, 'product_line') ?? readString(input, 'productLine') ?? '',
    biller: readString(input, 'biller'),
    billerCategory: readString(input, 'biller_category') ?? readString(input, 'billerCategory'),
    transactionType: readString(input, 'transaction_type') ?? readString(input, 'transactionType'),
    debitAccountCode:
      readString(input, 'debit_account_code') ?? readString(input, 'debitAccountCode') ?? '',
    status: readString(input, 'status') === 'inactive' ? 'inactive' : 'active',
    creditSplits: readCreditSplits(input)
  };
}

function toMappingRuleUpdateInput(input: unknown): UpdateMappingRule {
  if (!isRecord(input)) {
    throw new MappingValidationError(['Body must be an object']);
  }

  return {
    productLine: readString(input, 'product_line') ?? readString(input, 'productLine'),
    biller: readNullableString(input, 'biller'),
    billerCategory:
      readNullableString(input, 'biller_category') ?? readNullableString(input, 'billerCategory'),
    transactionType:
      readNullableString(input, 'transaction_type') ?? readNullableString(input, 'transactionType'),
    debitAccountCode:
      readString(input, 'debit_account_code') ?? readString(input, 'debitAccountCode'),
    creditSplits: Array.isArray(input.credit_splits) || Array.isArray(input.creditSplits)
      ? readCreditSplits(input)
      : undefined
  };
}

function readCreditSplits(input: Record<string, unknown>): NewMappingRule['creditSplits'] {
  const raw = input.credit_splits ?? input.creditSplits;
  if (!Array.isArray(raw)) return [];

  return raw.map((split) => {
    if (!isRecord(split)) {
      return { accountCode: '', percentageBps: 0 };
    }
    return {
      accountCode: readString(split, 'account_code') ?? readString(split, 'accountCode') ?? '',
      percentageBps:
        readNumber(split, 'percentage_bps') ?? readNumber(split, 'percentageBps') ?? 0
    };
  });
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNullableString(input: Record<string, unknown>, key: string): string | null | undefined {
  if (input[key] === null) return null;
  return readString(input, key);
}

function readGenericCsvConfig(input: Record<string, unknown>): GenericCsvConfig | undefined {
  const config = input.config;
  if (!isRecord(config)) return undefined;
  return config as unknown as GenericCsvConfig;
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

function readNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' ? value : undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function countCsvRows(content: string): number {
  const trimmed = content.trim();
  return trimmed ? trimmed.split('\n').length : 0;
}

function readStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}
