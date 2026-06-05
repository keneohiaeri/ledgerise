import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  postJournals as postGenericJournalCsv,
  validate as validateGenericJournalCsv,
} from '@ledgerise/adapter-outbound-generic-journal-csv';
import {
  postJournals as postZohoBooksJournals,
  validate as validateZohoBooksJournals,
} from '@ledgerise/adapter-outbound-zoho-books';
import {
  PostingService,
  PostingStateError,
  type ApiKeyPrincipal,
  type ApiScope,
  type PostingArtifact,
  type PostingBatch,
} from '@ledgerise/core-posting';

import { sha256 } from '../lib/crypto.js';
import {
  countCsvRows,
  getHeader,
  isRecord,
  readJsonBody,
  readNumber,
  readString,
  readStringArray,
  sendJson,
  sendText,
} from '../lib/http.js';
import { parsePagination } from '../lib/query.js';
import { toJournalEntryResponse } from './engine.js';

interface PostingRouteDeps {
  postingService: PostingService;
}

export async function handlePostingRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: PostingRouteDeps
): Promise<boolean> {
  const { postingService } = deps;

  if (request.method === 'POST' && url.pathname === '/api/posting-batches/generic-journal-csv') {
    const auth = await authenticatePostingRequest(request, response, 'posting_batches:create', postingService);
    if (!auth) return true;

    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
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
          return true;
        }
        sendJson(response, 200, {
          status: batch.status,
          replayed: true,
          batch: toPostingBatchResponse(batch, existingArtifact ?? undefined),
          artifact: existingArtifact ? toPostingArtifactResponse(existingArtifact, true) : undefined
        });
        return true;
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
        return true;
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
        return true;
      }
      throw error;
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/posting-batches/zoho-books') {
    const auth = await authenticatePostingRequest(request, response, 'posting_batches:create', postingService);
    if (!auth) return true;

    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
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
        return true;
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
        return true;
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
        return true;
      }
      throw error;
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/posting-batches') {
    const auth = await authenticatePostingRequest(request, response, 'posting_batches:read', postingService);
    if (!auth) return true;

    const pagination = parsePagination(url);
    if (!pagination.ok) {
      sendJson(response, 400, pagination.error);
      return true;
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
    return true;
  }

  const postingBatchArtifactMatch = /^\/api\/posting-batches\/([^/]+)\/artifact\.csv$/.exec(url.pathname);

  if (request.method === 'GET' && postingBatchArtifactMatch) {
    const auth = await authenticatePostingRequest(request, response, 'posting_artifacts:download', postingService);
    if (!auth) return true;

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
      return true;
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
    return true;
  }

  const postingBatchMatch = /^\/api\/posting-batches\/([^/]+)$/.exec(url.pathname);

  if (request.method === 'GET' && postingBatchMatch) {
    const auth = await authenticatePostingRequest(request, response, 'posting_batches:read', postingService);
    if (!auth) return true;

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
      return true;
    }
    const artifact = await postingService.findPostingArtifactByBatchId({
      operatorId: auth.operatorId,
      batchId
    });

    sendJson(response, 200, {
      record: toPostingBatchResponse(batch, artifact ?? undefined)
    });
    return true;
  }

  return false;
}

async function authenticatePostingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requiredScope: ApiScope,
  postingService: PostingService
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
