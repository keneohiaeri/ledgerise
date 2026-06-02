import type { CanonicalTransaction } from '@ledgerise/canonical-types';
import {
  validateCanonicalTransaction,
  type CanonicalValidationError
} from '@ledgerise/core-schema';

export type DedupeConfidence = 'high' | 'low';
export type IngestionStatus = 'accepted' | 'duplicate' | 'rejected';
export type IngestionErrorType = 'schema_validation' | 'adapter_mismatch' | 'duplicate_source';
export type PostingStatus = 'unposted';

export interface ListPage<T> {
  records: T[];
  page: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface PaginationInput {
  limit?: number;
  offset?: number;
}

export interface TransactionListInput extends OperatorScopedLookup, PaginationInput {
  status?: CanonicalTransaction['status'];
  postingStatus?: PostingStatus;
  productLine?: string;
  biller?: string;
  adapter?: string;
  environment?: 'live' | 'test';
  occurredFrom?: string;
  occurredTo?: string;
}

export interface IngestionErrorListInput extends OperatorScopedLookup, PaginationInput {
  adapterName?: string;
  errorType?: IngestionErrorType;
  sourceSystem?: string;
  sourceId?: string;
  occurredFrom?: string;
  occurredTo?: string;
}

export interface StoredCanonicalTransaction {
  id: string;
  operatorId: string;
  record: CanonicalTransaction;
  postingStatus: 'unposted';
  dedupeConfidence: DedupeConfidence;
  ingestedAt: string;
}

export interface StoredIngestionError {
  id: string;
  operatorId: string;
  adapterName: string;
  errorType: IngestionErrorType;
  sourceSystem?: string;
  sourceId?: string;
  existingTransactionId?: string;
  rawRecord: unknown;
  validationErrors: CanonicalValidationError[];
  occurredAt: string;
}

export interface StoredAdapterConfiguration {
  operatorId: string;
  name: string;
  enabled: boolean;
  config: unknown;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface IngestionRepository {
  findBySourceIdentity(input: SourceIdentityLookup): Promise<StoredCanonicalTransaction | null>;
  findTransactionById(input: TransactionIdentityLookup): Promise<StoredCanonicalTransaction | null>;
  listTransactions(input: TransactionListInput): Promise<ListPage<StoredCanonicalTransaction>>;
  listIngestionErrors(input: IngestionErrorListInput): Promise<ListPage<StoredIngestionError>>;
  listAdapterConfigurations(operatorId: string): Promise<StoredAdapterConfiguration[]>;
  findAdapterConfiguration(input: AdapterConfigurationLookup): Promise<StoredAdapterConfiguration | null>;
  saveAdapterConfiguration(input: SaveAdapterConfigurationInput): Promise<StoredAdapterConfiguration | null>;
  saveTransaction(input: NewStoredCanonicalTransaction): Promise<StoredCanonicalTransaction>;
  saveIngestionError(input: NewStoredIngestionError): Promise<StoredIngestionError>;
}

export class DuplicateSourceTransactionError extends Error {
  readonly existingTransaction: StoredCanonicalTransaction;

  constructor(existingTransaction: StoredCanonicalTransaction) {
    super('Duplicate source transaction');
    this.name = 'DuplicateSourceTransactionError';
    this.existingTransaction = existingTransaction;
  }
}

export interface SourceIdentityLookup {
  operatorId: string;
  sourceSystem: string;
  sourceAdapter: string;
  sourceId: string;
}

export interface TransactionIdentityLookup {
  operatorId: string;
  transactionId: string;
}

export interface OperatorScopedLookup {
  operatorId: string;
}

export interface AdapterConfigurationLookup extends OperatorScopedLookup {
  adapterName: string;
}

export interface SaveAdapterConfigurationInput extends AdapterConfigurationLookup {
  enabled?: boolean;
  config: unknown;
}

export interface NewStoredCanonicalTransaction {
  operatorId: string;
  record: CanonicalTransaction;
  dedupeConfidence: DedupeConfidence;
  ingestedAt: string;
}

export interface NewStoredIngestionError {
  operatorId: string;
  adapterName: string;
  errorType: IngestionErrorType;
  sourceSystem?: string;
  sourceId?: string;
  existingTransactionId?: string;
  rawRecord: unknown;
  validationErrors: CanonicalValidationError[];
  occurredAt: string;
}

export interface IngestCanonicalTransactionInput {
  operatorId: string;
  adapterName: string;
  record: unknown;
  receivedAt?: string;
}

export type IngestCanonicalTransactionResult =
  | {
      status: 'accepted';
      transaction: StoredCanonicalTransaction;
    }
  | {
      status: 'duplicate';
      existingTransaction: StoredCanonicalTransaction;
      marker: StoredIngestionError;
    }
  | {
      status: 'rejected';
      error: StoredIngestionError;
    };

export class IngestionService {
  private readonly repository: IngestionRepository;
  private readonly now: () => string;

  constructor(repository: IngestionRepository, options: { now?: () => string } = {}) {
    this.repository = repository;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async ingestCanonicalTransaction(
    input: IngestCanonicalTransactionInput
  ): Promise<IngestCanonicalTransactionResult> {
    const occurredAt = input.receivedAt ?? this.now();
    const validation = validateCanonicalTransaction(input.record);

    if (!validation.valid) {
      const error = await this.repository.saveIngestionError({
        operatorId: input.operatorId,
        adapterName: input.adapterName,
        errorType: 'schema_validation',
        sourceSystem: getNestedString(input.record, ['source', 'system']),
        sourceId: getNestedString(input.record, ['source_id']),
        rawRecord: input.record,
        validationErrors: validation.errors,
        occurredAt
      });

      return { status: 'rejected', error };
    }

    const record = input.record as CanonicalTransaction;

    if (record.source.adapter !== input.adapterName) {
      const error = await this.repository.saveIngestionError({
        operatorId: input.operatorId,
        adapterName: input.adapterName,
        errorType: 'adapter_mismatch',
        sourceSystem: record.source.system,
        sourceId: record.source_id,
        rawRecord: record,
        validationErrors: [
          {
            fieldPath: 'source.adapter',
            message: `Record source adapter "${record.source.adapter}" does not match route adapter "${input.adapterName}"`,
            rawValue: record.source.adapter,
            keyword: 'adapterName'
          }
        ],
        occurredAt
      });

      return { status: 'rejected', error };
    }

    if (record.source_id) {
      const existingTransaction = await this.repository.findBySourceIdentity({
        operatorId: input.operatorId,
        sourceSystem: record.source.system,
        sourceAdapter: record.source.adapter,
        sourceId: record.source_id
      });

      if (existingTransaction) {
        const marker = await this.repository.saveIngestionError({
          operatorId: input.operatorId,
          adapterName: input.adapterName,
          errorType: 'duplicate_source',
          sourceSystem: record.source.system,
          sourceId: record.source_id,
          existingTransactionId: existingTransaction.id,
          rawRecord: record,
          validationErrors: [],
          occurredAt
        });

        return { status: 'duplicate', existingTransaction, marker };
      }
    }

    let transaction: StoredCanonicalTransaction;

    try {
      transaction = await this.repository.saveTransaction({
        operatorId: input.operatorId,
        record,
        dedupeConfidence: record.source_id ? 'high' : 'low',
        ingestedAt: occurredAt
      });
    } catch (error) {
      if (!(error instanceof DuplicateSourceTransactionError)) {
        throw error;
      }

      const marker = await this.repository.saveIngestionError({
        operatorId: input.operatorId,
        adapterName: input.adapterName,
        errorType: 'duplicate_source',
        sourceSystem: record.source.system,
        sourceId: record.source_id,
        existingTransactionId: error.existingTransaction.id,
        rawRecord: record,
        validationErrors: [],
        occurredAt
      });

      return {
        status: 'duplicate',
        existingTransaction: error.existingTransaction,
        marker
      };
    }

    return { status: 'accepted', transaction };
  }
}

export class InMemoryIngestionRepository implements IngestionRepository {
  readonly transactions: StoredCanonicalTransaction[] = [];
  readonly ingestionErrors: StoredIngestionError[] = [];
  readonly adapterConfigurations = new Map<string, StoredAdapterConfiguration>();

  async findBySourceIdentity(
    input: SourceIdentityLookup
  ): Promise<StoredCanonicalTransaction | null> {
    return (
      this.transactions.find(
        (transaction) =>
          transaction.operatorId === input.operatorId &&
          transaction.record.source.system === input.sourceSystem &&
          transaction.record.source.adapter === input.sourceAdapter &&
          transaction.record.source_id === input.sourceId
      ) ?? null
    );
  }

  async findTransactionById(
    input: TransactionIdentityLookup
  ): Promise<StoredCanonicalTransaction | null> {
    return (
      this.transactions.find(
        (transaction) =>
          transaction.operatorId === input.operatorId && transaction.id === input.transactionId
      ) ?? null
    );
  }

  async listTransactions(input: TransactionListInput): Promise<ListPage<StoredCanonicalTransaction>> {
    const { limit, offset } = normalizePagination(input);
    const filtered = this.transactions
      .filter((transaction) => transaction.operatorId === input.operatorId)
      .filter((transaction) => !input.status || transaction.record.status === input.status)
      .filter(
        (transaction) => !input.postingStatus || transaction.postingStatus === input.postingStatus
      )
      .filter(
        (transaction) => !input.productLine || transaction.record.product.line === input.productLine
      )
      .filter((transaction) => !input.biller || transaction.record.product.biller === input.biller)
      .filter((transaction) => !input.adapter || transaction.record.source.adapter === input.adapter)
      .filter(
        (transaction) =>
          !input.environment ||
          (transaction.record.source.environment ?? 'live') === input.environment
      )
      .filter(
        (transaction) =>
          !input.occurredFrom || transaction.record.occurred_at >= input.occurredFrom
      )
      .filter(
        (transaction) => !input.occurredTo || transaction.record.occurred_at <= input.occurredTo
      )
      .sort(compareTransactionsDescending);

    return {
      records: filtered.slice(offset, offset + limit),
      page: {
        limit,
        offset,
        total: filtered.length
      }
    };
  }

  async listIngestionErrors(input: IngestionErrorListInput): Promise<ListPage<StoredIngestionError>> {
    const { limit, offset } = normalizePagination(input);
    const filtered = this.ingestionErrors
      .filter((error) => error.operatorId === input.operatorId)
      .filter((error) => !input.adapterName || error.adapterName === input.adapterName)
      .filter((error) => !input.errorType || error.errorType === input.errorType)
      .filter((error) => !input.sourceSystem || error.sourceSystem === input.sourceSystem)
      .filter((error) => !input.sourceId || error.sourceId === input.sourceId)
      .filter((error) => !input.occurredFrom || error.occurredAt >= input.occurredFrom)
      .filter((error) => !input.occurredTo || error.occurredAt <= input.occurredTo)
      .sort(compareIngestionErrorsDescending);

    return {
      records: filtered.slice(offset, offset + limit),
      page: {
        limit,
        offset,
        total: filtered.length
      }
    };
  }

  async saveTransaction(
    input: NewStoredCanonicalTransaction
  ): Promise<StoredCanonicalTransaction> {
    const transaction: StoredCanonicalTransaction = {
      id: input.record.id,
      operatorId: input.operatorId,
      record: input.record,
      postingStatus: 'unposted',
      dedupeConfidence: input.dedupeConfidence,
      ingestedAt: input.ingestedAt
    };

    this.transactions.push(transaction);
    return transaction;
  }

  async saveIngestionError(input: NewStoredIngestionError): Promise<StoredIngestionError> {
    const error: StoredIngestionError = {
      id: `ingestion_error_${this.ingestionErrors.length + 1}`,
      ...input
    };

    this.ingestionErrors.push(error);
    return error;
  }

  async listAdapterConfigurations(operatorId: string): Promise<StoredAdapterConfiguration[]> {
    return [...this.adapterConfigurations.values()]
      .filter((configuration) => configuration.operatorId === operatorId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async findAdapterConfiguration(
    input: AdapterConfigurationLookup
  ): Promise<StoredAdapterConfiguration | null> {
    return this.adapterConfigurations.get(adapterConfigurationKey(input.operatorId, input.adapterName)) ?? null;
  }

  async saveAdapterConfiguration(
    input: SaveAdapterConfigurationInput
  ): Promise<StoredAdapterConfiguration> {
    const key = adapterConfigurationKey(input.operatorId, input.adapterName);
    const current = this.adapterConfigurations.get(key);
    const configuration: StoredAdapterConfiguration = {
      operatorId: input.operatorId,
      name: input.adapterName,
      enabled: input.enabled ?? current?.enabled ?? true,
      config: input.config,
      metadata: {
        ...(current?.metadata ?? {}),
        config: input.config
      },
      updatedAt: new Date().toISOString()
    };

    this.adapterConfigurations.set(key, configuration);
    return configuration;
  }
}

function adapterConfigurationKey(operatorId: string, adapterName: string) {
  return `${operatorId}:${adapterName}`;
}

function getNestedString(input: unknown, path: string[]): string | undefined {
  const value = path.reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }

    return (current as Record<string, unknown>)[key];
  }, input);

  return typeof value === 'string' ? value : undefined;
}

function normalizePagination(input: PaginationInput): Required<PaginationInput> {
  return {
    limit: input.limit ?? 100,
    offset: input.offset ?? 0
  };
}

function compareTransactionsDescending(
  left: StoredCanonicalTransaction,
  right: StoredCanonicalTransaction
): number {
  return (
    right.record.occurred_at.localeCompare(left.record.occurred_at) ||
    right.ingestedAt.localeCompare(left.ingestedAt)
  );
}

function compareIngestionErrorsDescending(
  left: StoredIngestionError,
  right: StoredIngestionError
): number {
  return right.occurredAt.localeCompare(left.occurredAt);
}
