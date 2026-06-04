import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import pg from 'pg';

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
  type StoredPollCursor,
  type StoredPollRun,
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
  InMemoryJournalEngineRepository,
  JournalEngineService,
  type JournalEntry as EngineJournalEntry,
  type JournalEngineRepository
} from '@ledgerise/core-engine';
import { PostgresJournalEngineRepository } from '@ledgerise/core-engine/postgres';
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
const demoMode = process.env.DEMO_MODE === 'true';

type LogLevel = 'info' | 'warn' | 'error';

function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }) + '\n'
  );
}

// Adapter credential encryption — AES-256-GCM, application-layer.
// Set LEDGERISE_CREDENTIALS_KEY to a 32-byte key (64 hex chars or 44 base64 chars).
// If the env var is absent, config is stored and returned as plaintext (development mode).
const credentialsKey = ((): Buffer | null => {
  const raw = process.env.LEDGERISE_CREDENTIALS_KEY;
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('LEDGERISE_CREDENTIALS_KEY must be exactly 32 bytes (64 hex chars or 44 base64url chars)');
  return buf;
})();

function encryptConfig(config: unknown): unknown {
  if (!credentialsKey) return config;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialsKey, iv);
  const plaintext = Buffer.from(JSON.stringify(config), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encoded = Buffer.concat([iv, ciphertext, authTag]).toString('base64url');
  return { _enc: 1, d: encoded };
}

function decryptConfig(config: unknown): unknown {
  if (!credentialsKey || !isRecord(config) || config._enc !== 1) return config;
  const encoded = typeof config.d === 'string' ? config.d : null;
  if (!encoded) return config;
  try {
    const buf = Buffer.from(encoded, 'base64url');
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(buf.length - 16);
    const ciphertext = buf.subarray(12, buf.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', credentialsKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    log('error', 'credentials_decrypt_failed', {});
    return config;
  }
}

type UserRole = 'admin' | 'finance' | 'auditor';
type UserStatus = 'invited' | 'active' | 'disabled';

interface AccessUser {
  id: string;
  operatorId: string;
  email: string;
  displayName?: string;
  role: UserRole;
  status: UserStatus;
  invitedAt?: string;
  lastLoginAt?: string;
  passwordHash?: string;
  createdAt: string;
  updatedAt: string;
}

interface ManagedApiKey {
  id: string;
  operatorId: string;
  name: string;
  keyPrefix: string;
  scopes: ApiScope[];
  enabled: boolean;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface CreatedApiKey {
  record: ManagedApiKey;
  secret: string;
}

interface AuthPrincipal {
  userId: string;
  operatorId: string;
  email: string;
  role: UserRole;
}

interface AccessStore {
  listUsers(operatorId: string): Promise<AccessUser[]>;
  findUser(input: { operatorId: string; userId: string }): Promise<AccessUser | null>;
  findUserByEmail(input: { operatorId: string; email: string }): Promise<AccessUser | null>;
  inviteUser(input: {
    operatorId: string;
    email: string;
    displayName?: string;
    role: UserRole;
    passwordHash?: string;
  }): Promise<AccessUser>;
  updateUser(input: {
    operatorId: string;
    userId: string;
    role?: UserRole;
    status?: UserStatus;
    passwordHash?: string;
  }): Promise<AccessUser | null>;
  recordLogin(input: { operatorId: string; userId: string }): Promise<AccessUser | null>;
  listApiKeys(operatorId: string): Promise<ManagedApiKey[]>;
  createApiKey(input: {
    operatorId: string;
    name: string;
    scopes: ApiScope[];
    expiresAt?: string;
  }): Promise<CreatedApiKey>;
  revokeApiKey(input: { operatorId: string; apiKeyId: string }): Promise<ManagedApiKey | null>;
}

class InMemoryAccessStore implements AccessStore {
  private readonly users: AccessUser[] = [];
  private readonly apiKeys: Array<ManagedApiKey & { keyHash: string }> = [];

  async listUsers(operatorId: string): Promise<AccessUser[]> {
    return this.users
      .filter((user) => user.operatorId === operatorId)
      .sort((left, right) => left.email.localeCompare(right.email));
  }

  async findUser(input: { operatorId: string; userId: string }): Promise<AccessUser | null> {
    return (
      this.users.find((user) => user.operatorId === input.operatorId && user.id === input.userId) ??
      null
    );
  }

  async findUserByEmail(input: { operatorId: string; email: string }): Promise<AccessUser | null> {
    const email = input.email.toLowerCase();
    return (
      this.users.find(
        (user) => user.operatorId === input.operatorId && user.email.toLowerCase() === email
      ) ?? null
    );
  }

  async inviteUser(input: {
    operatorId: string;
    email: string;
    displayName?: string;
    role: UserRole;
    passwordHash?: string;
  }): Promise<AccessUser> {
    const existing = this.users.find(
      (user) => user.operatorId === input.operatorId && user.email === input.email
    );
    const now = new Date().toISOString();

    if (existing) {
      existing.displayName = input.displayName ?? existing.displayName;
      existing.role = input.role;
      existing.passwordHash = input.passwordHash ?? existing.passwordHash;
      existing.status = existing.status === 'disabled' ? 'active' : existing.status;
      existing.updatedAt = now;
      return existing;
    }

    const user: AccessUser = {
      id: `user_${this.users.length + 1}`,
      operatorId: input.operatorId,
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      passwordHash: input.passwordHash,
      status: 'invited',
      invitedAt: now,
      createdAt: now,
      updatedAt: now
    };

    this.users.push(user);
    return user;
  }

  async updateUser(input: {
    operatorId: string;
    userId: string;
    role?: UserRole;
    status?: UserStatus;
    passwordHash?: string;
  }): Promise<AccessUser | null> {
    const user = this.users.find(
      (item) => item.operatorId === input.operatorId && item.id === input.userId
    );
    if (!user) return null;

    user.role = input.role ?? user.role;
    user.status = input.status ?? user.status;
    user.passwordHash = input.passwordHash ?? user.passwordHash;
    user.updatedAt = new Date().toISOString();
    return user;
  }

  async recordLogin(input: { operatorId: string; userId: string }): Promise<AccessUser | null> {
    const user = await this.findUser(input);
    if (!user) return null;

    const now = new Date().toISOString();
    user.lastLoginAt = now;
    user.updatedAt = now;
    return user;
  }

  async listApiKeys(operatorId: string): Promise<ManagedApiKey[]> {
    return this.apiKeys
      .filter((apiKey) => apiKey.operatorId === operatorId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(({ keyHash: _keyHash, ...apiKey }) => apiKey);
  }

  async createApiKey(input: {
    operatorId: string;
    name: string;
    scopes: ApiScope[];
    expiresAt?: string;
  }): Promise<CreatedApiKey> {
    const secret = createApiKeySecret();
    const now = new Date().toISOString();
    const record: ManagedApiKey & { keyHash: string } = {
      id: `api_key_${this.apiKeys.length + 1}`,
      operatorId: input.operatorId,
      name: input.name,
      keyPrefix: secret.slice(0, 16),
      keyHash: sha256(secret),
      scopes: input.scopes,
      enabled: true,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now
    };
    this.apiKeys.push(record);
    const { keyHash: _keyHash, ...safeRecord } = record;
    return { record: safeRecord, secret };
  }

  async revokeApiKey(input: { operatorId: string; apiKeyId: string }): Promise<ManagedApiKey | null> {
    const apiKey = this.apiKeys.find(
      (item) => item.operatorId === input.operatorId && item.id === input.apiKeyId
    );
    if (!apiKey) return null;

    const now = new Date().toISOString();
    apiKey.enabled = false;
    apiKey.revokedAt = now;
    apiKey.updatedAt = now;
    const { keyHash: _keyHash, ...safeRecord } = apiKey;
    return safeRecord;
  }
}

class PostgresAccessStore implements AccessStore {
  private readonly pool: pg.Pool;

  constructor(options: { connectionString: string; max?: number }) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10
    });
  }

  async listUsers(operatorId: string): Promise<AccessUser[]> {
    const result = await this.pool.query<AccessUserRow>(
      `
        SELECT id, operator_id, email, display_name, role, status, invited_at, last_login_at, password_hash, created_at, updated_at
        FROM users
        WHERE operator_id = $1
        ORDER BY email ASC
      `,
      [operatorId]
    );
    return result.rows.map(toAccessUser);
  }

  async findUser(input: { operatorId: string; userId: string }): Promise<AccessUser | null> {
    const result = await this.pool.query<AccessUserRow>(
      `
        SELECT id, operator_id, email, display_name, role, status, invited_at, last_login_at, password_hash, created_at, updated_at
        FROM users
        WHERE operator_id = $1 AND id = $2
        LIMIT 1
      `,
      [input.operatorId, input.userId]
    );
    return result.rows[0] ? toAccessUser(result.rows[0]) : null;
  }

  async findUserByEmail(input: { operatorId: string; email: string }): Promise<AccessUser | null> {
    const result = await this.pool.query<AccessUserRow>(
      `
        SELECT id, operator_id, email, display_name, role, status, invited_at, last_login_at, password_hash, created_at, updated_at
        FROM users
        WHERE operator_id = $1 AND lower(email) = lower($2)
        LIMIT 1
      `,
      [input.operatorId, input.email]
    );
    return result.rows[0] ? toAccessUser(result.rows[0]) : null;
  }

  async inviteUser(input: {
    operatorId: string;
    email: string;
    displayName?: string;
    role: UserRole;
    passwordHash?: string;
  }): Promise<AccessUser> {
    const result = await this.pool.query<AccessUserRow>(
      `
        INSERT INTO users (operator_id, email, display_name, role, status, invited_at, password_hash)
        VALUES ($1, $2, $3, $4, 'invited', now(), $5)
        ON CONFLICT (operator_id, email) DO UPDATE SET
          display_name = COALESCE(EXCLUDED.display_name, users.display_name),
          role = EXCLUDED.role,
          password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
          status = CASE WHEN users.status = 'disabled' THEN 'active' ELSE users.status END,
          updated_at = now()
        RETURNING id, operator_id, email, display_name, role, status, invited_at, last_login_at, password_hash, created_at, updated_at
      `,
      [input.operatorId, input.email, input.displayName ?? null, input.role, input.passwordHash ?? null]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to invite user');
    return toAccessUser(row);
  }

  async updateUser(input: {
    operatorId: string;
    userId: string;
    role?: UserRole;
    status?: UserStatus;
    passwordHash?: string;
  }): Promise<AccessUser | null> {
    const result = await this.pool.query<AccessUserRow>(
      `
        UPDATE users
        SET
          role = COALESCE($3, role),
          status = COALESCE($4, status),
          password_hash = COALESCE($5, password_hash),
          updated_at = now()
        WHERE operator_id = $1 AND id = $2
        RETURNING id, operator_id, email, display_name, role, status, invited_at, last_login_at, password_hash, created_at, updated_at
      `,
      [input.operatorId, input.userId, input.role ?? null, input.status ?? null, input.passwordHash ?? null]
    );
    return result.rows[0] ? toAccessUser(result.rows[0]) : null;
  }

  async recordLogin(input: { operatorId: string; userId: string }): Promise<AccessUser | null> {
    const result = await this.pool.query<AccessUserRow>(
      `
        UPDATE users
        SET
          last_login_at = now(),
          updated_at = now()
        WHERE operator_id = $1 AND id = $2
        RETURNING id, operator_id, email, display_name, role, status, invited_at, last_login_at, password_hash, created_at, updated_at
      `,
      [input.operatorId, input.userId]
    );
    return result.rows[0] ? toAccessUser(result.rows[0]) : null;
  }

  async listApiKeys(operatorId: string): Promise<ManagedApiKey[]> {
    const result = await this.pool.query<ApiKeyManagementRow>(
      `
        SELECT id, operator_id, name, key_prefix, scopes, enabled, expires_at, last_used_at, revoked_at, created_at, updated_at
        FROM api_keys
        WHERE operator_id = $1
        ORDER BY created_at DESC
      `,
      [operatorId]
    );
    return result.rows.map(toManagedApiKey);
  }

  async createApiKey(input: {
    operatorId: string;
    name: string;
    scopes: ApiScope[];
    expiresAt?: string;
  }): Promise<CreatedApiKey> {
    const secret = createApiKeySecret();
    const result = await this.pool.query<ApiKeyManagementRow>(
      `
        INSERT INTO api_keys (operator_id, name, key_prefix, key_hash, scopes, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, operator_id, name, key_prefix, scopes, enabled, expires_at, last_used_at, revoked_at, created_at, updated_at
      `,
      [
        input.operatorId,
        input.name,
        secret.slice(0, 16),
        sha256(secret),
        input.scopes,
        input.expiresAt ?? null
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to create API key');
    return { record: toManagedApiKey(row), secret };
  }

  async revokeApiKey(input: { operatorId: string; apiKeyId: string }): Promise<ManagedApiKey | null> {
    const result = await this.pool.query<ApiKeyManagementRow>(
      `
        UPDATE api_keys
        SET enabled = false, revoked_at = now(), updated_at = now()
        WHERE operator_id = $1 AND id = $2
        RETURNING id, operator_id, name, key_prefix, scopes, enabled, expires_at, last_used_at, revoked_at, created_at, updated_at
      `,
      [input.operatorId, input.apiKeyId]
    );
    return result.rows[0] ? toManagedApiKey(result.rows[0]) : null;
  }
}

const { ingestionRepository, mappingRepository, postingRepository, engineRepository, accessStore, defaultOperatorId, repositoryKind, pgPool } =
  await createRepositories();
await bootstrapAdminUser();
if (pgPool) {
  try {
    await bootstrapSystemSettings(pgPool, defaultOperatorId);
    await loadSystemSettingsIntoCache(pgPool, defaultOperatorId);
  } catch {
    log('warn', 'system_settings_load_failed', { hint: 'Run migration 0010_system_settings.sql' });
  }
}
const ingestionService = new IngestionService(ingestionRepository);
const mappingService = new MappingService(mappingRepository);
const postingService = new PostingService(postingRepository);
const engineService = new JournalEngineService(engineRepository);

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

interface AccessUserRow {
  id: string;
  operator_id: string;
  email: string;
  display_name: string | null;
  role: UserRole;
  status: UserStatus;
  invited_at: Date | string | null;
  last_login_at: Date | string | null;
  password_hash: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ApiKeyManagementRow {
  id: string;
  operator_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  enabled: boolean;
  expires_at: Date | string | null;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SystemSettings {
  engineCronSchedule: string;
  batchSize: number;
  suspenseAccountCode: string;
  maxRetryAttempts: number;
  backoffStrategy: 'exponential' | 'fixed';
}

const defaultSystemSettings: SystemSettings = {
  engineCronSchedule: process.env.ENGINE_SCHEDULE_CRON ?? '0 * * * *',
  batchSize: Number(process.env.ENGINE_BATCH_SIZE ?? 500),
  suspenseAccountCode: process.env.SUSPENSE_ACCOUNT_CODE ?? '9999',
  maxRetryAttempts: 5,
  backoffStrategy: 'exponential'
};

const systemSettingsStore = new Map<string, SystemSettings>();

function getSystemSettings(operatorId: string): SystemSettings {
  return systemSettingsStore.get(operatorId) ?? { ...defaultSystemSettings };
}

function patchSystemSettings(operatorId: string, patch: Partial<SystemSettings>): SystemSettings {
  const current = getSystemSettings(operatorId);
  const updated: SystemSettings = { ...current, ...patch };
  systemSettingsStore.set(operatorId, updated);
  return updated;
}

async function bootstrapSystemSettings(pool: pg.Pool, operatorId: string): Promise<void> {
  const defaults = getSystemSettings(operatorId);
  await pool.query(
    `INSERT INTO system_settings (operator_id, engine_cron_schedule, batch_size, suspense_account_code, max_retry_attempts, backoff_strategy)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (operator_id) DO NOTHING`,
    [operatorId, defaults.engineCronSchedule, defaults.batchSize, defaults.suspenseAccountCode, defaults.maxRetryAttempts, defaults.backoffStrategy]
  );
}

async function loadSystemSettingsIntoCache(pool: pg.Pool, operatorId: string): Promise<void> {
  const result = await pool.query<{
    engine_cron_schedule: string;
    batch_size: number;
    suspense_account_code: string;
    max_retry_attempts: number;
    backoff_strategy: string;
  }>('SELECT * FROM system_settings WHERE operator_id = $1', [operatorId]);

  if (result.rows[0]) {
    const row = result.rows[0];
    systemSettingsStore.set(operatorId, {
      engineCronSchedule: row.engine_cron_schedule,
      batchSize: row.batch_size,
      suspenseAccountCode: row.suspense_account_code,
      maxRetryAttempts: row.max_retry_attempts,
      backoffStrategy: row.backoff_strategy as 'exponential' | 'fixed'
    });
  }
}

async function persistSystemSettings(pool: pg.Pool, operatorId: string, settings: SystemSettings): Promise<void> {
  await pool.query(
    `UPDATE system_settings
     SET engine_cron_schedule = $2, batch_size = $3, suspense_account_code = $4,
         max_retry_attempts = $5, backoff_strategy = $6, updated_at = now()
     WHERE operator_id = $1`,
    [operatorId, settings.engineCronSchedule, settings.batchSize, settings.suspenseAccountCode, settings.maxRetryAttempts, settings.backoffStrategy]
  );
}

const userRoles = new Set(['admin', 'finance', 'auditor']);
const userStatuses = new Set(['invited', 'active', 'disabled']);

const INGEST_RATE_LIMIT = Number(process.env.INGEST_RATE_LIMIT ?? '120');
const INGEST_RATE_WINDOW_MS = 60_000;
const ingestRateCounts = new Map<string, { count: number; windowStart: number }>();

function checkIngestRateLimit(remoteAddr: string): boolean {
  const now = Date.now();
  const entry = ingestRateCounts.get(remoteAddr);
  if (!entry || now - entry.windowStart >= INGEST_RATE_WINDOW_MS) {
    ingestRateCounts.set(remoteAddr, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= INGEST_RATE_LIMIT) return false;
  entry.count += 1;
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - INGEST_RATE_WINDOW_MS;
  for (const [key, entry] of ingestRateCounts) {
    if (entry.windowStart < cutoff) ingestRateCounts.delete(key);
  }
}, 60_000).unref();

const server = createServer(async (request, response) => {
  const requestStart = Date.now();
  const requestMethod = request.method ?? 'UNKNOWN';
  const requestPath = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`
  ).pathname;

  response.on('finish', () => {
    log('info', 'http_request', {
      method: requestMethod,
      path: requestPath,
      status: response.statusCode,
      duration_ms: Date.now() - requestStart,
      remote_addr: request.socket.remoteAddress
    });
  });

  try {
    await handleRequest(request, response);
  } catch (error) {
    log('error', 'unhandled_request_error', {
      method: requestMethod,
      path: requestPath,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    if (!response.headersSent) {
      sendJson(response, 500, { status: 'error', code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    }
  }
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  applyCors(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && (url.pathname === '/healthcheck' || url.pathname === '/api/health')) {
    if (repositoryKind === 'postgres') {
      try {
        await dbHealthCheck();
        sendJson(response, 200, { status: 'ok', service: 'ledgerise-api', repository: repositoryKind, db: 'ok' });
      } catch {
        log('error', 'health_db_failed', {});
        sendJson(response, 503, { status: 'error', service: 'ledgerise-api', repository: repositoryKind, db: 'unavailable' });
      }
    } else {
      sendJson(response, 200, { status: 'ok', service: 'ledgerise-api', repository: repositoryKind });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }

    const payload = isRecord(body.value) ? body.value : {};
    const email = readString(payload, 'email');
    const password = readString(payload, 'password');

    if (!email || !password) {
      sendJson(response, 400, {
        status: 'error',
        code: 'INVALID_LOGIN',
        message: 'Body must include email and password'
      });
      return;
    }

    const operatorId = getOperatorId(request);
    const user = await accessStore.findUserByEmail({ operatorId, email });

    if (
      !user ||
      user.status === 'disabled' ||
      !user.passwordHash ||
      !verifyPassword(password, user.passwordHash)
    ) {
      log('warn', 'auth_login_failed', { operatorId, email });
      sendJson(response, 401, {
        status: 'error',
        code: 'AUTHENTICATION_FAILED',
        message: 'Email or password is incorrect'
      });
      return;
    }

    const loggedInUser = (await accessStore.recordLogin({ operatorId, userId: user.id })) ?? user;
    log('info', 'auth_login', { operatorId, userId: user.id, role: user.role });
    sendJson(response, 200, {
      token: signAuthToken(loggedInUser),
      expires_in_seconds: 8 * 60 * 60,
      user: toUserResponse(loggedInUser)
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/me') {
    const principal = verifyAuthToken(request);
    if (!principal) {
      sendJson(response, 401, {
        status: 'error',
        code: 'AUTHENTICATION_REQUIRED',
        message: 'A valid bearer token is required'
      });
      return;
    }

    const user = await accessStore.findUser({
      operatorId: principal.operatorId,
      userId: principal.userId
    });

    if (!user || user.status === 'disabled') {
      sendJson(response, 401, {
        status: 'error',
        code: 'AUTHENTICATION_REQUIRED',
        message: 'A valid bearer token is required'
      });
      return;
    }

    sendJson(response, 200, { user: toUserResponse(user) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    const principal = verifyAuthToken(request);
    if (principal) log('info', 'auth_logout', { operatorId: principal.operatorId, userId: principal.userId });
    sendJson(response, 200, { status: 'ok' });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/change-password') {
    if (demoMode) {
      sendJson(response, 403, { status: 'error', code: 'DEMO_MODE', message: 'Password changes are disabled in demo mode.' });
      return;
    }
    const principal = verifyAuthToken(request);
    if (!principal) {
      sendJson(response, 401, {
        status: 'error',
        code: 'AUTHENTICATION_REQUIRED',
        message: 'A valid bearer token is required'
      });
      return;
    }

    const user = await accessStore.findUser({
      operatorId: principal.operatorId,
      userId: principal.userId
    });

    if (!user || user.status === 'disabled') {
      sendJson(response, 401, {
        status: 'error',
        code: 'AUTHENTICATION_REQUIRED',
        message: 'A valid bearer token is required'
      });
      return;
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }

    const payload = isRecord(body.value) ? body.value : {};
    const newPassword = readString(payload, 'password') ?? readString(payload, 'new_password');
    if (!newPassword || newPassword.length < 8) {
      sendJson(response, 400, {
        status: 'error',
        code: 'INVALID_PASSWORD',
        message: 'Password must be at least 8 characters'
      });
      return;
    }

    const updated = await accessStore.updateUser({
      operatorId: principal.operatorId,
      userId: principal.userId,
      status: 'active',
      passwordHash: hashPassword(newPassword)
    });

    if (!updated) {
      sendJson(response, 404, { status: 'error', code: 'USER_NOT_FOUND', message: 'User not found' });
      return;
    }

    sendJson(response, 200, {
      token: signAuthToken(updated),
      expires_in_seconds: 8 * 60 * 60,
      user: toUserResponse(updated)
    });
    return;
  }

  let dashboardPrincipal: AuthPrincipal | null = null;
  if (isDashboardApiPath(url.pathname)) {
    dashboardPrincipal = await authorizeDashboardRequest(request, response);
    if (!dashboardPrincipal) return;
  }

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
      return;
    }
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
      return;
    }

    if (adapter.direction !== 'inbound' || !adapter.modes.includes('poll')) {
      sendJson(response, 400, {
        status: 'error',
        code: 'ADAPTER_NOT_POLLABLE',
        message: `Adapter "${adapterName}" does not expose poll status`
      });
      return;
    }

    const operatorId = getOperatorId(request);
    const pagination = parsePagination(url);

    if (!pagination.ok) {
      sendJson(response, 400, pagination.error);
      return;
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
    return;
  }

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
    if (!requireRole(dashboardPrincipal!, response, ['admin'])) return;
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
      config: encryptConfig(config)
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
        config: decryptConfig(saved.config)
      }
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/users') {
    sendJson(response, 200, {
      records: (await accessStore.listUsers(getOperatorId(request))).map(toUserResponse)
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/users/invitations') {
    if (!requireRole(dashboardPrincipal!, response, ['admin'])) return;
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }

    const payload = isRecord(body.value) ? body.value : {};
    const email = readString(payload, 'email');
    const role = readUserRole(payload.role);
    const password = readString(payload, 'password') ?? readString(payload, 'initial_password');

    if (!email || !role) {
      sendJson(response, 400, {
        status: 'error',
        code: 'INVALID_USER_INVITE',
        message: 'Body must include email and a supported role'
      });
      return;
    }

    const user = await accessStore.inviteUser({
      operatorId: getOperatorId(request),
      email,
      displayName: readString(payload, 'display_name') ?? readString(payload, 'name'),
      role,
      passwordHash: password ? hashPassword(password) : undefined
    });
    sendJson(response, 201, { record: toUserResponse(user) });
    return;
  }

  const userMatch = /^\/api\/users\/([^/]+)$/.exec(url.pathname);
  if (userMatch && request.method === 'PATCH') {
    if (!requireRole(dashboardPrincipal!, response, ['admin'])) return;
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }

    const payload = isRecord(body.value) ? body.value : {};
    const role = payload.role === undefined ? undefined : readUserRole(payload.role);
    const status = payload.status === undefined ? undefined : readUserStatus(payload.status);
    const password = readString(payload, 'password') ?? readString(payload, 'new_password');

    if ((payload.role !== undefined && !role) || (payload.status !== undefined && !status)) {
      sendJson(response, 400, {
        status: 'error',
        code: 'INVALID_USER_UPDATE',
        message: 'Body includes an unsupported role or status'
      });
      return;
    }

    const user = await accessStore.updateUser({
      operatorId: getOperatorId(request),
      userId: decodeURIComponent(userMatch[1] ?? ''),
      role,
      status,
      passwordHash: password ? hashPassword(password) : undefined
    });

    if (!user) {
      sendJson(response, 404, { status: 'error', code: 'USER_NOT_FOUND', message: 'User not found' });
      return;
    }

    sendJson(response, 200, { record: toUserResponse(user) });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/api-keys') {
    sendJson(response, 200, {
      records: (await accessStore.listApiKeys(getOperatorId(request))).map(toApiKeyResponse)
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/api-keys') {
    if (!requireRole(dashboardPrincipal!, response, ['admin'])) return;
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }

    const payload = isRecord(body.value) ? body.value : {};
    const name = readString(payload, 'name');
    const scopes = readApiScopes(payload.scopes);
    const expiresAt = readString(payload, 'expires_at');

    if (!name || scopes.length === 0 || (expiresAt && Number.isNaN(Date.parse(expiresAt)))) {
      sendJson(response, 400, {
        status: 'error',
        code: 'INVALID_API_KEY',
        message: 'Body must include name, at least one supported scope, and optional ISO expires_at'
      });
      return;
    }

    const created = await accessStore.createApiKey({
      operatorId: getOperatorId(request),
      name,
      scopes,
      expiresAt
    });
    sendJson(response, 201, {
      record: toApiKeyResponse(created.record),
      secret: created.secret
    });
    return;
  }

  const apiKeyRevokeMatch = /^\/api\/api-keys\/([^/]+)\/revoke$/.exec(url.pathname);
  if (apiKeyRevokeMatch && request.method === 'POST') {
    if (!requireRole(dashboardPrincipal!, response, ['admin'])) return;
    const apiKey = await accessStore.revokeApiKey({
      operatorId: getOperatorId(request),
      apiKeyId: decodeURIComponent(apiKeyRevokeMatch[1] ?? '')
    });

    if (!apiKey) {
      sendJson(response, 404, { status: 'error', code: 'API_KEY_NOT_FOUND', message: 'API key not found' });
      return;
    }

    sendJson(response, 200, { record: toApiKeyResponse(apiKey) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/import/generic-csv') {
    if (!requireRole(dashboardPrincipal!, response, ['admin', 'finance'])) return;
    const upload = await readMultipartFile(request);
    if (!upload.ok) {
      sendJson(response, 400, { status: 'error', code: 'INVALID_BODY', message: upload.message });
      return;
    }

    const content = upload.content.toString('utf8');
    if (!content.trim()) {
      sendJson(response, 400, { status: 'error', code: 'INVALID_BODY', message: 'Uploaded file is empty' });
      return;
    }

    const savedConfig = await getAdapterConfiguration(getOperatorId(request), 'generic-csv');
    const normalized = await normalizeGenericCsv({
      content,
      filename: upload.filename,
      config: readGenericCsvConfigFromStored(savedConfig) ?? defaultGenericCsvConfig
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

  if (request.method === 'GET' && url.pathname === '/api/transactions/stats') {
    if (!requireRole(dashboardPrincipal!, response, ['admin', 'finance', 'auditor'])) return;
    const operatorId = getOperatorId(request);
    if (!pgPool) {
      sendJson(response, 200, { stats: { settled: 0, pendingTest: 0, unmapped: 0 } });
      return;
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
    sendJson(response, 200, { stats: {
      settled: Number(row?.settled ?? 0),
      pendingTest: Number(row?.pending_test ?? 0),
      unmapped: Number(row?.unmapped ?? 0)
    }});
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

  if (request.method === 'GET' && url.pathname === '/api/journal-entries/stats') {
    if (!requireRole(dashboardPrincipal!, response, ['admin', 'finance', 'auditor'])) return;
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
    if (!requireRole(dashboardPrincipal!, response, ['admin', 'finance'])) return;
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
    if (!requireRole(dashboardPrincipal!, response, ['admin', 'finance'])) return;
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

  const coaAccountMatch = /^\/api\/coa\/([^/]+)$/.exec(url.pathname);
  if (coaAccountMatch) {
    const code = decodeURIComponent(coaAccountMatch[1] ?? '');
    if (request.method === 'PATCH') {
      if (!requireRole(dashboardPrincipal!, response, ['admin', 'finance'])) return;
      const body = await readJsonBody(request);
      if (!body.ok) { sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message }); return; }
      const active = isRecord(body.value) && typeof body.value.active === 'boolean' ? body.value.active : null;
      if (active === null) { sendJson(response, 400, { status: 'error', code: 'INVALID_BODY', message: 'Body must include active (boolean)' }); return; }
      const updated = await mappingService.updateChartAccount(getOperatorId(request), code, { active });
      if (!updated) { sendJson(response, 404, { status: 'error', code: 'NOT_FOUND', message: 'Account not found' }); return; }
      sendJson(response, 200, { record: updated });
      return;
    }
    if (request.method === 'DELETE') {
      if (!requireRole(dashboardPrincipal!, response, ['admin', 'finance'])) return;
      const deleted = await mappingService.deleteChartAccount(getOperatorId(request), code);
      if (!deleted) { sendJson(response, 404, { status: 'error', code: 'NOT_FOUND', message: 'Account not found' }); return; }
      sendJson(response, 200, { status: 'ok' });
      return;
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/mapping-rules') {
    sendJson(response, 200, {
      records: await mappingService.listMappingRules(getOperatorId(request))
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/mapping-rules') {
    if (!requireRole(dashboardPrincipal!, response, ['admin', 'finance'])) return;
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
    if (!requireRole(dashboardPrincipal!, response, ['admin', 'finance'])) return;
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
    if (!requireRole(dashboardPrincipal!, response, ['admin', 'finance'])) return;
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

  if (request.method === 'POST' && url.pathname === '/api/engine/run') {
    if (!requireRole(dashboardPrincipal!, response, ['admin', 'finance'])) return;
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
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/system-settings') {
    sendJson(response, 200, { record: getSystemSettings(getOperatorId(request)) });
    return;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/system-settings') {
    if (!requireRole(dashboardPrincipal!, response, ['admin'])) return;
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return;
    }

    const payload = isRecord(body.value) ? body.value : {};
    const patch: Partial<SystemSettings> = {};

    const cronSchedule = readString(payload, 'engine_cron_schedule');
    if (cronSchedule !== undefined) patch.engineCronSchedule = cronSchedule;

    const batchSize = readNumber(payload, 'batch_size');
    if (batchSize !== undefined && Number.isInteger(batchSize) && batchSize > 0) {
      patch.batchSize = batchSize;
    }

    const suspenseCode = readString(payload, 'suspense_account_code');
    if (suspenseCode !== undefined) patch.suspenseAccountCode = suspenseCode;

    const maxRetry = readNumber(payload, 'max_retry_attempts');
    if (maxRetry !== undefined && Number.isInteger(maxRetry) && maxRetry >= 0) {
      patch.maxRetryAttempts = maxRetry;
    }

    const backoff = payload.backoff_strategy;
    if (backoff === 'exponential' || backoff === 'fixed') {
      patch.backoffStrategy = backoff;
    }

    const updated = patchSystemSettings(getOperatorId(request), patch);
    if (pgPool) await persistSystemSettings(pgPool, getOperatorId(request), updated);
    sendJson(response, 200, { record: updated });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/audit-log.csv') {
    if (!requireRole(dashboardPrincipal!, response, ['admin'])) return;

    if (!pgPool) {
      sendJson(response, 503, { status: 'error', code: 'NOT_AVAILABLE', message: 'Audit log requires a database connection' });
      return;
    }

    const operatorId = getOperatorId(request);
    const client = await pgPool.connect();
    try {
      const result = await client.query<{
        id: string;
        actor_id: string | null;
        event_type: string;
        entity_type: string;
        entity_id: string | null;
        before_state: unknown;
        after_state: unknown;
        metadata: unknown;
        occurred_at: Date;
      }>(
        `SELECT ae.id, ae.actor_id, ae.event_type, ae.entity_type, ae.entity_id,
                ae.before_state, ae.after_state, ae.metadata, ae.occurred_at,
                u.email AS actor_email
         FROM audit_events ae
         LEFT JOIN users u ON u.id = ae.actor_id
         WHERE ae.operator_id = $1
         ORDER BY ae.occurred_at DESC
         LIMIT 50000`,
        [operatorId]
      );

      const escape = (v: unknown): string => {
        if (v === null || v === undefined) return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };

      const header = 'id,occurred_at,event_type,entity_type,entity_id,actor_email,actor_id,before_state,after_state,metadata\n';
      const rows = result.rows.map((row) =>
        [
          row.id,
          row.occurred_at.toISOString(),
          row.event_type,
          row.entity_type,
          row.entity_id ?? '',
          (row as Record<string, unknown>)['actor_email'] ?? '',
          row.actor_id ?? '',
          row.before_state,
          row.after_state,
          row.metadata
        ]
          .map(escape)
          .join(',')
      );

      const csv = header + rows.join('\n');
      const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      sendText(response, 200, csv, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`
      });
    } finally {
      client.release();
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/demo/reset') {
    if (!demoMode) {
      sendJson(response, 404, { status: 'error', code: 'NOT_FOUND', message: 'Route not found' });
      return;
    }
    const principal = verifyAuthToken(request);
    if (!principal || principal.role !== 'admin') {
      sendJson(response, 403, { status: 'error', code: 'FORBIDDEN', message: 'Admin access required' });
      return;
    }
    if (!pgPool) {
      sendJson(response, 503, { status: 'error', code: 'NOT_AVAILABLE', message: 'Demo reset requires a database connection' });
      return;
    }
    const client = await pgPool.connect();
    try {
      await client.query(`
        TRUNCATE
          posting_artifact_downloads,
          posting_artifacts,
          posting_attempts,
          posting_batches,
          journal_entry_lines,
          journal_entries,
          mapping_rule_versions,
          mapping_rules,
          chart_of_accounts,
          transaction_ingestion_errors,
          canonical_transactions,
          adapter_poll_runs,
          adapter_poll_cursors,
          audit_events,
          api_keys,
          users
        RESTART IDENTITY CASCADE
      `);
      await client.query(`
        INSERT INTO chart_of_accounts (operator_id, code, name, type)
        SELECT operators.id, account.code, account.name, account.type
        FROM operators
        CROSS JOIN (
          VALUES
            ('1000', 'Cash / Settlement Asset', 'asset'),
            ('1100', 'Aggregator Float', 'asset'),
            ('2000', 'Customer Liability', 'liability'),
            ('4000', 'Bill Payment Revenue', 'revenue'),
            ('5000', 'Processing Fees', 'expense'),
            ('9999', 'Suspense', 'liability')
        ) AS account(code, name, type)
        WHERE operators.slug = $1
        ON CONFLICT (operator_id, code) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, updated_at = now()
      `, [process.env.DEFAULT_OPERATOR_SLUG ?? 'local-operator']);
      const bootstrapEmail = process.env.LEDGERISE_BOOTSTRAP_ADMIN_EMAIL;
      const bootstrapPassword = process.env.LEDGERISE_BOOTSTRAP_ADMIN_PASSWORD;
      const bootstrapName = process.env.LEDGERISE_BOOTSTRAP_ADMIN_NAME ?? 'Ledgerise Admin';
      if (bootstrapEmail && bootstrapPassword) {
        await accessStore.inviteUser({
          operatorId: defaultOperatorId,
          email: bootstrapEmail,
          displayName: bootstrapName,
          role: 'admin',
          passwordHash: hashPassword(bootstrapPassword)
        });
      }
      log('info', 'demo_reset', { operatorId: principal.operatorId, userId: principal.userId });
      sendJson(response, 200, { status: 'ok' });
    } finally {
      client.release();
    }
    return;
  }

  sendJson(response, 404, {
    status: 'error',
    code: 'NOT_FOUND',
    message: 'Route not found'
  });
}

server.listen(port, () => {
  log('info', 'server_start', { port, repository: repositoryKind });
});

async function createRepositories(): Promise<{
  ingestionRepository: IngestionRepository;
  mappingRepository: MappingRepository;
  postingRepository: PostingRepository;
  engineRepository: JournalEngineRepository;
  accessStore: AccessStore;
  defaultOperatorId: string;
  repositoryKind: 'memory' | 'postgres';
  pgPool: pg.Pool | null;
}> {
  if (!process.env.DATABASE_URL) {
    return {
      ingestionRepository: new InMemoryIngestionRepository(),
      mappingRepository: new InMemoryMappingRepository(),
      postingRepository: new InMemoryPostingRepository(),
      engineRepository: new InMemoryJournalEngineRepository(),
      accessStore: new InMemoryAccessStore(),
      defaultOperatorId: process.env.DEFAULT_OPERATOR_ID ?? 'local-operator',
      repositoryKind: 'memory',
      pgPool: null
    };
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const ingestionRepository = new PostgresIngestionRepository({
    connectionString: process.env.DATABASE_URL
  });
  const mappingRepository = new PostgresMappingRepository({
    connectionString: process.env.DATABASE_URL
  });
  const postingRepository = new PostgresPostingRepository({
    connectionString: process.env.DATABASE_URL
  });
  const engineRepository = new PostgresJournalEngineRepository({
    connectionString: process.env.DATABASE_URL
  });
  const accessStore = new PostgresAccessStore({ connectionString: process.env.DATABASE_URL });
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
    engineRepository,
    accessStore,
    defaultOperatorId,
    repositoryKind: 'postgres',
    pgPool: pool
  };
}

async function dbHealthCheck(): Promise<void> {
  if (!pgPool) return;
  const client = await pgPool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

async function bootstrapAdminUser(): Promise<void> {
  const email = process.env.LEDGERISE_BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.LEDGERISE_BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return;

  const existing = await accessStore.findUserByEmail({ operatorId: defaultOperatorId, email });
  if (existing) return;

  await accessStore.inviteUser({
    operatorId: defaultOperatorId,
    email,
    displayName: process.env.LEDGERISE_BOOTSTRAP_ADMIN_NAME ?? 'Ledgerise Admin',
    role: 'admin',
    passwordHash: hashPassword(password)
  });
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

async function readMultipartFile(
  request: IncomingMessage
): Promise<{ ok: true; content: Buffer; filename?: string } | { ok: false; message: string }> {
  const contentType = request.headers['content-type'] ?? '';
  const boundaryMatch = /boundary=([^\s;]+)/i.exec(contentType);
  const boundary = boundaryMatch?.[1];
  if (!boundary) {
    return { ok: false, message: 'Expected multipart/form-data with a file field' };
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);

  const dashBoundary = Buffer.from(`--${boundary}`);
  const headerSep = Buffer.from('\r\n\r\n');

  let pos = body.indexOf(dashBoundary);
  while (pos !== -1) {
    pos += dashBoundary.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;

    const headerEnd = body.indexOf(headerSep, pos);
    if (headerEnd === -1) break;

    const headers = body.slice(pos, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const nextBoundary = body.indexOf(dashBoundary, contentStart);
    const rawEnd = nextBoundary === -1 ? body.length : nextBoundary;
    const contentEnd =
      rawEnd >= 2 && body[rawEnd - 2] === 0x0d && body[rawEnd - 1] === 0x0a ? rawEnd - 2 : rawEnd;

    const filenameMatch = /filename="([^"]*)"/i.exec(headers);
    if (filenameMatch !== null) {
      return {
        ok: true,
        content: body.slice(contentStart, contentEnd),
        filename: filenameMatch[1] || undefined
      };
    }

    pos = nextBoundary === -1 ? -1 : nextBoundary;
  }

  return { ok: false, message: 'No file field found in multipart body' };
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
      config: decryptConfig(configuration?.config ?? defaultAdapterConfigs[adapter.name] ?? {})
    };
  });
}

async function getAdapterConfiguration(
  operatorId: string,
  adapterName: string
): Promise<StoredAdapterConfiguration | null> {
  const configuration = await ingestionRepository.findAdapterConfiguration({ operatorId, adapterName });
  if (!configuration) return null;
  return { ...configuration, config: decryptConfig(configuration.config) };
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

  if (getNestedString(payload, ['source', 'adapter']) === adapterName) {
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

function getNestedString(input: unknown, path: string[]): string | undefined {
  const value = path.reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }

    return (current as Record<string, unknown>)[key];
  }, input);

  return typeof value === 'string' ? value : undefined;
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

function getClientIp(request: IncomingMessage): string {
  const forwarded = getHeader(request.headers['x-forwarded-for']);
  return forwarded?.split(',')[0]?.trim() ?? request.socket.remoteAddress ?? 'unknown';
}

function getOperatorId(request: IncomingMessage): string {
  return verifyAuthToken(request)?.operatorId ?? getHeader(request.headers['x-operator-id']) ?? defaultOperatorId;
}

async function authorizeDashboardRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<AuthPrincipal | null> {
  const principal = verifyAuthToken(request);
  if (!principal) {
    sendJson(response, 401, {
      status: 'error',
      code: 'AUTHENTICATION_REQUIRED',
      message: 'A valid dashboard session is required'
    });
    return null;
  }

  const user = await accessStore.findUser({
    operatorId: principal.operatorId,
    userId: principal.userId
  });

  if (!user || user.status === 'disabled') {
    sendJson(response, 401, {
      status: 'error',
      code: 'AUTHENTICATION_REQUIRED',
      message: 'A valid dashboard session is required'
    });
    return null;
  }

  if (user.status === 'invited') {
    sendJson(response, 403, {
      status: 'error',
      code: 'MUST_CHANGE_PASSWORD',
      message: 'You must set a new password before accessing the dashboard'
    });
    return null;
  }

  return principal;
}

function requireRole(
  principal: AuthPrincipal,
  response: ServerResponse,
  allowed: UserRole[]
): boolean {
  if (allowed.includes(principal.role)) return true;
  sendJson(response, 403, {
    status: 'error',
    code: 'FORBIDDEN',
    message: `Your role (${principal.role}) does not have permission for this action`
  });
  return false;
}

function isDashboardApiPath(pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  if (pathname.startsWith('/api/auth/')) return false;
  if (pathname.startsWith('/api/ingest/')) return false;
  if (pathname.startsWith('/api/posting-batches')) return false;
  if (pathname.startsWith('/api/posting-artifacts')) return false;
  return true;
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

function toUserResponse(user: AccessUser) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    role: user.role,
    status: user.status,
    has_password: Boolean(user.passwordHash),
    invited_at: user.invitedAt,
    last_login_at: user.lastLoginAt,
    created_at: user.createdAt,
    updated_at: user.updatedAt
  };
}

function toApiKeyResponse(apiKey: ManagedApiKey) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    key_prefix: apiKey.keyPrefix,
    scopes: apiKey.scopes,
    enabled: apiKey.enabled,
    expires_at: apiKey.expiresAt,
    last_used_at: apiKey.lastUsedAt,
    revoked_at: apiKey.revokedAt,
    created_at: apiKey.createdAt,
    updated_at: apiKey.updatedAt
  };
}

function toPollCursorResponse(cursor: StoredPollCursor) {
  return {
    adapter_name: cursor.adapterName,
    cursor: cursor.cursor,
    advanced_at: cursor.advancedAt,
    updated_at: cursor.updatedAt
  };
}

function toAccessUser(row: AccessUserRow): AccessUser {
  return {
    id: row.id,
    operatorId: row.operator_id,
    email: row.email,
    displayName: row.display_name ?? undefined,
    role: row.role,
    status: row.status,
    invitedAt: row.invited_at ? toIsoString(row.invited_at) : undefined,
    lastLoginAt: row.last_login_at ? toIsoString(row.last_login_at) : undefined,
    passwordHash: row.password_hash ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function toManagedApiKey(row: ApiKeyManagementRow): ManagedApiKey {
  return {
    id: row.id,
    operatorId: row.operator_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes.filter((scope): scope is ApiScope => isApiScope(scope)),
    enabled: row.enabled,
    expiresAt: row.expires_at ? toIsoString(row.expires_at) : undefined,
    lastUsedAt: row.last_used_at ? toIsoString(row.last_used_at) : undefined,
    revokedAt: row.revoked_at ? toIsoString(row.revoked_at) : undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toEngineEntryResponse(entry: EngineJournalEntry) {
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

function toPollRunResponse(run: StoredPollRun) {
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
    ruleType: readRuleType(input),
    entries: readEntries(input),
    status: readString(input, 'status') === 'inactive' ? 'inactive' : 'active'
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
    ruleType: readRuleType(input),
    entries: Array.isArray(input.entries) ? readEntries(input) : undefined
  };
}

function readRuleType(input: Record<string, unknown>): 'simple' | 'compound' {
  const raw = readString(input, 'rule_type') ?? readString(input, 'ruleType');
  return raw === 'compound' ? 'compound' : 'simple';
}

function readEntries(input: Record<string, unknown>): NewMappingRule['entries'] {
  const raw = input.entries;
  if (!Array.isArray(raw)) return [];

  return raw.map((item) => {
    if (!isRecord(item)) return { debitAccountCode: '', creditSplits: [] };
    return {
      label: readString(item, 'label'),
      debitAccountCode:
        readString(item, 'debit_account_code') ?? readString(item, 'debitAccountCode') ?? '',
      creditSplits: readCreditSplits(item)
    };
  });
}

function readCreditSplits(input: Record<string, unknown>): Array<{ accountCode: string; percentageBps: number }> {
  const raw = input.credit_splits ?? input.creditSplits;
  if (!Array.isArray(raw)) return [];

  return raw.map((split) => {
    if (!isRecord(split)) return { accountCode: '', percentageBps: 0 };
    return {
      accountCode: readString(split, 'account_code') ?? readString(split, 'accountCode') ?? '',
      percentageBps: readNumber(split, 'percentage_bps') ?? readNumber(split, 'percentageBps') ?? 0
    };
  });
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readUserRole(input: unknown): UserRole | undefined {
  return typeof input === 'string' && userRoles.has(input) ? (input as UserRole) : undefined;
}

function readUserStatus(input: unknown): UserStatus | undefined {
  return typeof input === 'string' && userStatuses.has(input) ? (input as UserStatus) : undefined;
}

function readApiScopes(input: unknown): ApiScope[] {
  if (!Array.isArray(input)) return [];
  return input.filter((scope): scope is ApiScope => typeof scope === 'string' && isApiScope(scope));
}

function isApiScope(input: string): input is ApiScope {
  return (
    input === 'posting_batches:create' ||
    input === 'posting_batches:read' ||
    input === 'posting_artifacts:download'
  );
}

function createApiKeySecret(): string {
  return `lr_live_sk_${randomBytes(24).toString('base64url')}`;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const key = scryptSync(password, salt, 64).toString('base64url');
  return `scrypt:${salt}:${key}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [scheme, salt, expectedKey] = storedHash.split(':');
  if (scheme !== 'scrypt' || !salt || !expectedKey) return false;

  const actual = Buffer.from(scryptSync(password, salt, 64).toString('base64url'));
  const expected = Buffer.from(expectedKey);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function signAuthToken(user: AccessUser): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: user.id,
    operator_id: user.operatorId,
    email: user.email,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60
  };
  const encodedHeader = encodeTokenPart(header);
  const encodedPayload = encodeTokenPart(payload);
  const signature = signTokenParts(encodedHeader, encodedPayload);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyAuthToken(request: IncomingMessage): AuthPrincipal | null {
  const authorization = getHeader(request.headers.authorization);
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
  if (!token) return null;

  const [encodedHeader, encodedPayload, signature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !signature) return null;

  const expectedSignature = signTokenParts(encodedHeader, encodedPayload);
  if (!constantTimeEqual(signature, expectedSignature)) return null;

  const payload = decodeTokenPart(encodedPayload);
  if (!isRecord(payload)) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.operator_id !== 'string' ||
    typeof payload.email !== 'string' ||
    typeof payload.role !== 'string' ||
    !userRoles.has(payload.role)
  ) {
    return null;
  }

  return {
    userId: payload.sub,
    operatorId: payload.operator_id,
    email: payload.email,
    role: payload.role as UserRole
  };
}

function encodeTokenPart(input: unknown): string {
  return Buffer.from(JSON.stringify(input), 'utf8').toString('base64url');
}

function decodeTokenPart(input: string): unknown {
  try {
    return JSON.parse(Buffer.from(input, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function signTokenParts(encodedHeader: string, encodedPayload: string): string {
  return createHmac('sha256', process.env.AUTH_TOKEN_SECRET ?? 'ledgerise-local-development-secret')
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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
