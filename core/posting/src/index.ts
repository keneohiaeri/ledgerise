import { randomUUID } from 'node:crypto';

export type PostingStatus =
  | 'generated'
  | 'posting'
  | 'posted'
  | 'failed'
  | 'unmapped'
  | 'retry_exhausted';

export type PostingAttemptStatus =
  | 'queued'
  | 'posting'
  | 'posted'
  | 'failed'
  | 'retry_requested';

export interface JournalLogLine {
  accountCode: string;
  side: 'debit' | 'credit';
  amount: number;
  currency: string;
  lineOrder: number;
}

export interface JournalLogEntry {
  id: string;
  operatorId: string;
  transactionId: string;
  entryType: 'standard' | 'reversal' | 'unmapped';
  status: 'generated' | 'unmapped';
  postingStatus: PostingStatus;
  currency: string;
  amount: number;
  mappingRuleId?: string;
  mappingRuleVersion?: number;
  reversalOfJournalEntryId?: string;
  entryOrder: number;
  entryLabel?: string;
  generatedAt: string;
  postedAt?: string;
  lastPostingAttemptAt?: string;
  lastPostingError?: string;
  attemptCount: number;
  lines: JournalLogLine[];
  transaction?: JournalLogTransaction;
  attempts: PostingAttempt[];
  latestAttempt?: PostingAttempt;
}

export interface JournalLogTransaction {
  id: string;
  sourceId?: string;
  status: string;
  type: string;
  occurredAt: string;
  settledAt?: string | null;
  sourceAdapter: string;
  sourceSystem: string;
  productLine: string;
  productBiller?: string;
  productBillerCategory?: string;
}

export interface PostingAttempt {
  id: string;
  operatorId: string;
  journalEntryId: string;
  postingBatchId?: string;
  adapterName: string;
  status: PostingAttemptStatus;
  attemptNumber: number;
  externalReference?: string;
  errorCode?: string;
  errorMessage?: string;
  requestedByUserId?: string;
  occurredAt: string;
}

export type PostingBatchStatus = 'queued' | 'posting' | 'posted' | 'failed' | 'retry_exhausted';

export interface PostingBatch {
  id: string;
  operatorId: string;
  adapterName: string;
  status: PostingBatchStatus;
  journalEntryCount: number;
  idempotencyKey?: string;
  createdByApiKeyId?: string;
  createdAt: string;
  updatedAt: string;
  entries: JournalLogEntry[];
  replayed?: boolean;
}

export interface CreatePostingBatchInput {
  operatorId: string;
  adapterName: string;
  journalEntryIds?: string[];
  idempotencyKey?: string;
  createdByApiKeyId?: string;
  limit?: number;
  occurredAt?: string;
}

export interface CompletePostingBatchResult {
  journalEntryId: string;
  status: 'posted' | 'failed';
  externalReference?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface CompletePostingBatchInput {
  operatorId: string;
  batchId: string;
  adapterName: string;
  results: CompletePostingBatchResult[];
  occurredAt?: string;
}

export type ApiScope =
  | 'posting_batches:create'
  | 'posting_batches:read'
  | 'posting_artifacts:download';

export interface ApiKeyPrincipal {
  id: string;
  operatorId: string;
  name: string;
  scopes: ApiScope[];
}

export interface PostingArtifact {
  id: string;
  operatorId: string;
  postingBatchId: string;
  contentType: string;
  filename: string;
  content: string;
  checksumSha256: string;
  sizeBytes: number;
  rowCount: number;
  createdByApiKeyId?: string;
  createdAt: string;
}

export interface SavePostingArtifactInput {
  operatorId: string;
  postingBatchId: string;
  contentType: string;
  filename: string;
  content: string;
  checksumSha256: string;
  sizeBytes: number;
  rowCount: number;
  createdByApiKeyId?: string;
  createdAt?: string;
}

export interface ListPostingBatchesInput {
  operatorId: string;
  limit?: number;
  offset?: number;
}

export interface RecordPostingArtifactDownloadInput {
  operatorId: string;
  postingArtifactId: string;
  postingBatchId: string;
  apiKeyId?: string;
  userAgent?: string;
  remoteAddr?: string;
  downloadedAt?: string;
}

export interface ListJournalEntriesInput {
  operatorId: string;
  limit?: number;
  offset?: number;
  postingStatus?: PostingStatus;
}

export interface ListPage<T> {
  records: T[];
  page: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface ManualRetryInput {
  operatorId: string;
  journalEntryId: string;
  adapterName: string;
  requestedByUserId?: string;
  occurredAt?: string;
}

export interface PostingRepository {
  authenticateApiKey(input: {
    keyHash: string;
    requiredScope: ApiScope;
    occurredAt: string;
  }): Promise<ApiKeyPrincipal | null>;
  listJournalEntries(input: ListJournalEntriesInput & {
    limit: number;
    offset: number;
  }): Promise<ListPage<JournalLogEntry>>;
  findJournalEntry(input: {
    operatorId: string;
    journalEntryId: string;
  }): Promise<JournalLogEntry | null>;
  requestManualRetry(input: ManualRetryInput & {
    occurredAt: string;
  }): Promise<JournalLogEntry | null>;
  createPostingBatch(input: CreatePostingBatchInput & {
    limit: number;
    occurredAt: string;
  }): Promise<PostingBatch>;
  completePostingBatch(input: CompletePostingBatchInput & {
    occurredAt: string;
  }): Promise<PostingBatch | null>;
  listPostingBatches(input: ListPostingBatchesInput & {
    limit: number;
    offset: number;
  }): Promise<ListPage<PostingBatch>>;
  findPostingBatch(input: {
    operatorId: string;
    batchId: string;
  }): Promise<PostingBatch | null>;
  savePostingArtifact(input: SavePostingArtifactInput & {
    createdAt: string;
  }): Promise<PostingArtifact>;
  findPostingArtifactByBatchId(input: {
    operatorId: string;
    batchId: string;
  }): Promise<PostingArtifact | null>;
  recordPostingArtifactDownload(input: RecordPostingArtifactDownloadInput & {
    downloadedAt: string;
  }): Promise<void>;
}

export class PostingStateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PostingStateError';
    this.code = code;
  }
}

export class PostingService {
  private readonly now: () => string;

  constructor(private readonly repository: PostingRepository, options: { now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  listJournalEntries(input: ListJournalEntriesInput): Promise<ListPage<JournalLogEntry>> {
    return this.repository.listJournalEntries({
      operatorId: input.operatorId,
      limit: input.limit ?? 100,
      offset: input.offset ?? 0,
      postingStatus: input.postingStatus
    });
  }

  findJournalEntry(input: {
    operatorId: string;
    journalEntryId: string;
  }): Promise<JournalLogEntry | null> {
    return this.repository.findJournalEntry(input);
  }

  authenticateApiKey(input: {
    keyHash: string;
    requiredScope: ApiScope;
  }): Promise<ApiKeyPrincipal | null> {
    return this.repository.authenticateApiKey({
      keyHash: input.keyHash,
      requiredScope: input.requiredScope,
      occurredAt: this.now()
    });
  }

  async requestManualRetry(input: ManualRetryInput): Promise<JournalLogEntry | null> {
    const entry = await this.repository.findJournalEntry({
      operatorId: input.operatorId,
      journalEntryId: input.journalEntryId
    });

    if (!entry) return null;
    if (!['failed', 'retry_exhausted'].includes(entry.postingStatus)) {
      throw new PostingStateError(
        'ENTRY_NOT_RETRYABLE',
        `Journal entry ${input.journalEntryId} is ${entry.postingStatus}, not retryable`
      );
    }

    return this.repository.requestManualRetry({
      operatorId: input.operatorId,
      journalEntryId: input.journalEntryId,
      adapterName: input.adapterName,
      requestedByUserId: input.requestedByUserId,
      occurredAt: input.occurredAt ?? this.now()
    });
  }

  async createPostingBatch(input: CreatePostingBatchInput): Promise<PostingBatch> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new PostingStateError(
        'INVALID_BATCH_LIMIT',
        'Posting batch limit must be an integer from 1 to 500'
      );
    }

    const batch = await this.repository.createPostingBatch({
      operatorId: input.operatorId,
      adapterName: input.adapterName,
      journalEntryIds: input.journalEntryIds,
      idempotencyKey: input.idempotencyKey,
      createdByApiKeyId: input.createdByApiKeyId,
      limit,
      occurredAt: input.occurredAt ?? this.now()
    });

    if (batch.entries.length === 0 && !batch.replayed) {
      throw new PostingStateError('NO_POSTABLE_JOURNALS', 'No generated journal entries are ready to post');
    }

    return batch;
  }

  completePostingBatch(input: CompletePostingBatchInput): Promise<PostingBatch | null> {
    return this.repository.completePostingBatch({
      operatorId: input.operatorId,
      batchId: input.batchId,
      adapterName: input.adapterName,
      results: input.results,
      occurredAt: input.occurredAt ?? this.now()
    });
  }

  listPostingBatches(input: ListPostingBatchesInput): Promise<ListPage<PostingBatch>> {
    return this.repository.listPostingBatches({
      operatorId: input.operatorId,
      limit: input.limit ?? 100,
      offset: input.offset ?? 0
    });
  }

  findPostingBatch(input: {
    operatorId: string;
    batchId: string;
  }): Promise<PostingBatch | null> {
    return this.repository.findPostingBatch(input);
  }

  savePostingArtifact(input: SavePostingArtifactInput): Promise<PostingArtifact> {
    return this.repository.savePostingArtifact({
      ...input,
      createdAt: input.createdAt ?? this.now()
    });
  }

  findPostingArtifactByBatchId(input: {
    operatorId: string;
    batchId: string;
  }): Promise<PostingArtifact | null> {
    return this.repository.findPostingArtifactByBatchId(input);
  }

  recordPostingArtifactDownload(input: RecordPostingArtifactDownloadInput): Promise<void> {
    return this.repository.recordPostingArtifactDownload({
      ...input,
      downloadedAt: input.downloadedAt ?? this.now()
    });
  }
}

export class InMemoryPostingRepository implements PostingRepository {
  readonly entries: JournalLogEntry[] = [];
  readonly attempts: PostingAttempt[] = [];
  readonly batches: PostingBatch[] = [];
  readonly apiKeys: Array<ApiKeyPrincipal & { keyHash: string }> = [];
  readonly artifacts: PostingArtifact[] = [];
  readonly downloads: Array<RecordPostingArtifactDownloadInput & { downloadedAt: string }> = [];

  async authenticateApiKey(input: {
    keyHash: string;
    requiredScope: ApiScope;
    occurredAt: string;
  }): Promise<ApiKeyPrincipal | null> {
    const apiKey = this.apiKeys.find(
      (item) => item.keyHash === input.keyHash && item.scopes.includes(input.requiredScope)
    );
    if (!apiKey) return null;
    return {
      id: apiKey.id,
      operatorId: apiKey.operatorId,
      name: apiKey.name,
      scopes: apiKey.scopes
    };
  }

  async listJournalEntries(input: ListJournalEntriesInput & {
    limit: number;
    offset: number;
  }): Promise<ListPage<JournalLogEntry>> {
    const filtered = this.entries.filter((entry) => {
      if (entry.operatorId !== input.operatorId) return false;
      return input.postingStatus ? entry.postingStatus === input.postingStatus : true;
    });

    return {
      records: filtered.slice(input.offset, input.offset + input.limit),
      page: {
        limit: input.limit,
        offset: input.offset,
        total: filtered.length
      }
    };
  }

  async findJournalEntry(input: {
    operatorId: string;
    journalEntryId: string;
  }): Promise<JournalLogEntry | null> {
    return (
      this.entries.find(
        (entry) => entry.operatorId === input.operatorId && entry.id === input.journalEntryId
      ) ?? null
    );
  }

  async requestManualRetry(input: ManualRetryInput & {
    occurredAt: string;
  }): Promise<JournalLogEntry | null> {
    const entry = await this.findJournalEntry(input);
    if (!entry) return null;

    const attempt: PostingAttempt = {
      id: randomUUID(),
      operatorId: input.operatorId,
      journalEntryId: input.journalEntryId,
      adapterName: input.adapterName,
      status: 'retry_requested',
      attemptNumber: entry.attemptCount + 1,
      requestedByUserId: input.requestedByUserId || undefined,
      occurredAt: input.occurredAt
    };
    this.attempts.push(attempt);

    entry.postingStatus = 'generated';
    entry.lastPostingAttemptAt = input.occurredAt;
    entry.lastPostingError = undefined;
    entry.attemptCount += 1;
    entry.latestAttempt = attempt;
    return entry;
  }

  async createPostingBatch(input: CreatePostingBatchInput & {
    limit: number;
    occurredAt: string;
  }): Promise<PostingBatch> {
    if (input.idempotencyKey) {
      const existing = this.batches.find(
        (batch) =>
          batch.operatorId === input.operatorId &&
          batch.adapterName === input.adapterName &&
          batch.idempotencyKey === input.idempotencyKey
      );
      if (existing) return { ...existing, replayed: true };
    }

    const entries = this.entries
      .filter((entry) => {
        if (entry.operatorId !== input.operatorId || entry.postingStatus !== 'generated') return false;
        return input.journalEntryIds ? input.journalEntryIds.includes(entry.id) : true;
      })
      .slice(0, input.limit);

    const batch: PostingBatch = {
      id: randomUUID(),
      operatorId: input.operatorId,
      adapterName: input.adapterName,
      status: 'posting',
      journalEntryCount: entries.length,
      idempotencyKey: input.idempotencyKey,
      createdByApiKeyId: input.createdByApiKeyId,
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt,
      entries
    };
    this.batches.push(batch);

    for (const entry of entries) {
      const attempt: PostingAttempt = {
        id: randomUUID(),
        operatorId: input.operatorId,
        journalEntryId: entry.id,
        postingBatchId: batch.id,
        adapterName: input.adapterName,
        status: 'posting',
        attemptNumber: entry.attemptCount + 1,
        occurredAt: input.occurredAt
      };
      this.attempts.push(attempt);
      entry.postingStatus = 'posting';
      entry.lastPostingAttemptAt = input.occurredAt;
      entry.attemptCount += 1;
      entry.latestAttempt = attempt;
      entry.attempts = [attempt, ...entry.attempts];
    }

    return batch;
  }

  async completePostingBatch(input: CompletePostingBatchInput & {
    occurredAt: string;
  }): Promise<PostingBatch | null> {
    const batch = this.batches.find(
      (item) =>
        item.operatorId === input.operatorId &&
        item.id === input.batchId &&
        item.adapterName === input.adapterName
    );
    if (!batch) return null;

    const resultByEntryId = new Map(input.results.map((result) => [result.journalEntryId, result]));

    for (const entry of batch.entries) {
      const result = resultByEntryId.get(entry.id);
      if (!result) continue;

      const attempt = this.attempts.find(
        (item) => item.postingBatchId === batch.id && item.journalEntryId === entry.id
      );
      if (attempt) {
        attempt.status = result.status;
        attempt.externalReference = result.externalReference;
        attempt.errorCode = result.errorCode;
        attempt.errorMessage = result.errorMessage;
        attempt.occurredAt = input.occurredAt;
      }

      entry.postingStatus = result.status;
      entry.postedAt = result.status === 'posted' ? input.occurredAt : undefined;
      entry.lastPostingAttemptAt = input.occurredAt;
      entry.lastPostingError = result.status === 'failed' ? result.errorMessage : undefined;
      entry.latestAttempt = attempt;
    }

    batch.status = input.results.some((result) => result.status === 'failed') ? 'failed' : 'posted';
    batch.updatedAt = input.occurredAt;
    return batch;
  }

  async listPostingBatches(input: ListPostingBatchesInput & {
    limit: number;
    offset: number;
  }): Promise<ListPage<PostingBatch>> {
    const filtered = this.batches.filter((batch) => batch.operatorId === input.operatorId);
    return {
      records: filtered.slice(input.offset, input.offset + input.limit),
      page: {
        limit: input.limit,
        offset: input.offset,
        total: filtered.length
      }
    };
  }

  async findPostingBatch(input: {
    operatorId: string;
    batchId: string;
  }): Promise<PostingBatch | null> {
    return (
      this.batches.find(
        (batch) => batch.operatorId === input.operatorId && batch.id === input.batchId
      ) ?? null
    );
  }

  async savePostingArtifact(input: SavePostingArtifactInput & {
    createdAt: string;
  }): Promise<PostingArtifact> {
    const existing = this.artifacts.find(
      (artifact) =>
        artifact.operatorId === input.operatorId && artifact.postingBatchId === input.postingBatchId
    );
    if (existing) return existing;

    const artifact: PostingArtifact = {
      id: randomUUID(),
      operatorId: input.operatorId,
      postingBatchId: input.postingBatchId,
      contentType: input.contentType,
      filename: input.filename,
      content: input.content,
      checksumSha256: input.checksumSha256,
      sizeBytes: input.sizeBytes,
      rowCount: input.rowCount,
      createdByApiKeyId: input.createdByApiKeyId,
      createdAt: input.createdAt
    };
    this.artifacts.push(artifact);
    return artifact;
  }

  async findPostingArtifactByBatchId(input: {
    operatorId: string;
    batchId: string;
  }): Promise<PostingArtifact | null> {
    return (
      this.artifacts.find(
        (artifact) =>
          artifact.operatorId === input.operatorId && artifact.postingBatchId === input.batchId
      ) ?? null
    );
  }

  async recordPostingArtifactDownload(input: RecordPostingArtifactDownloadInput & {
    downloadedAt: string;
  }): Promise<void> {
    this.downloads.push(input);
  }
}
