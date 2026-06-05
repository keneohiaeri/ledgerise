import pg from 'pg';

import {
  InMemoryIngestionRepository,
  type IngestionRepository,
} from '@ledgerise/core-ingestion';
import { PostgresIngestionRepository } from '@ledgerise/core-ingestion/postgres';
import {
  InMemoryMappingRepository,
  type MappingRepository,
} from '@ledgerise/core-mapping';
import { PostgresMappingRepository } from '@ledgerise/core-mapping/postgres';
import {
  InMemoryJournalEngineRepository,
  type JournalEngineRepository,
} from '@ledgerise/core-engine';
import { PostgresJournalEngineRepository } from '@ledgerise/core-engine/postgres';
import {
  InMemoryPostingRepository,
  type ApiScope,
  type PostingRepository,
} from '@ledgerise/core-posting';
import { PostgresPostingRepository } from '@ledgerise/core-posting/postgres';

import { createApiKeySecret, hashPassword, sha256 } from './lib/crypto.js';
import { type AccessUser, type UserRole, type UserStatus } from './middleware/auth.js';

export interface ManagedApiKey {
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

export interface CreatedApiKey {
  record: ManagedApiKey;
  secret: string;
}

export interface AccessStore {
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

export class InMemoryAccessStore implements AccessStore {
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

export class PostgresAccessStore implements AccessStore {
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

export interface SystemSettings {
  engineCronSchedule: string;
  batchSize: number;
  suspenseAccountCode: string;
  maxRetryAttempts: number;
  backoffStrategy: 'exponential' | 'fixed';
}

export const defaultSystemSettings: SystemSettings = {
  engineCronSchedule: process.env.ENGINE_SCHEDULE_CRON ?? '0 * * * *',
  batchSize: Number(process.env.ENGINE_BATCH_SIZE ?? 500),
  suspenseAccountCode: process.env.SUSPENSE_ACCOUNT_CODE ?? '9999',
  maxRetryAttempts: 5,
  backoffStrategy: 'exponential'
};

export const systemSettingsStore = new Map<string, SystemSettings>();

export function getSystemSettings(operatorId: string): SystemSettings {
  return systemSettingsStore.get(operatorId) ?? { ...defaultSystemSettings };
}

export function patchSystemSettings(operatorId: string, patch: Partial<SystemSettings>): SystemSettings {
  const current = getSystemSettings(operatorId);
  const updated: SystemSettings = { ...current, ...patch };
  systemSettingsStore.set(operatorId, updated);
  return updated;
}

export async function bootstrapSystemSettings(pool: pg.Pool, operatorId: string): Promise<void> {
  const defaults = getSystemSettings(operatorId);
  await pool.query(
    `INSERT INTO system_settings (operator_id, engine_cron_schedule, batch_size, suspense_account_code, max_retry_attempts, backoff_strategy)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (operator_id) DO NOTHING`,
    [operatorId, defaults.engineCronSchedule, defaults.batchSize, defaults.suspenseAccountCode, defaults.maxRetryAttempts, defaults.backoffStrategy]
  );
}

export async function loadSystemSettingsIntoCache(pool: pg.Pool, operatorId: string): Promise<void> {
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

export async function persistSystemSettings(pool: pg.Pool, operatorId: string, settings: SystemSettings): Promise<void> {
  await pool.query(
    `UPDATE system_settings
     SET engine_cron_schedule = $2, batch_size = $3, suspense_account_code = $4,
         max_retry_attempts = $5, backoff_strategy = $6, updated_at = now()
     WHERE operator_id = $1`,
    [operatorId, settings.engineCronSchedule, settings.batchSize, settings.suspenseAccountCode, settings.maxRetryAttempts, settings.backoffStrategy]
  );
}

export function isApiScope(input: string): input is ApiScope {
  return (
    input === 'posting_batches:create' ||
    input === 'posting_batches:read' ||
    input === 'posting_artifacts:download'
  );
}

export function readApiScopes(input: unknown): ApiScope[] {
  if (!Array.isArray(input)) return [];
  return input.filter((scope): scope is ApiScope => typeof scope === 'string' && isApiScope(scope));
}

export async function createRepositories(): Promise<{
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

export async function dbHealthCheck(pool: pg.Pool | null): Promise<void> {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

export async function bootstrapAdminUser(
  accessStore: AccessStore,
  defaultOperatorId: string
): Promise<void> {
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
