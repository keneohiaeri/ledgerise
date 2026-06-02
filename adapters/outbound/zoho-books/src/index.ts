import type {
  AdapterErrorCode,
  AdapterHealthcheckResult,
  AdapterMeta,
  AdapterValidationError,
  AdapterValidationResult,
  OutboundJournalBatch,
  OutboundJournalEntry,
  OutboundJournalPostFailure,
  OutboundJournalPostResult,
  OutboundJournalPostSuccess
} from '@ledgerise/adapter-sdk';

import adapter from '../adapter.json' with { type: 'json' };

export interface ZohoBooksConfig {
  organizationId: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  accountsBaseUrl: string;
  apiBaseUrl: string;
  accountMap: Record<string, string>;
  amountScale: number;
  status: 'draft' | 'published';
}

interface ZohoTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface ZohoJournalResponse {
  code?: number;
  message?: string;
  journal?: {
    journal_id?: string;
    entry_number?: string;
    reference_number?: string;
  };
}

export function meta(): AdapterMeta {
  return adapter as AdapterMeta;
}

export function validate(input: OutboundJournalBatch): AdapterValidationResult {
  return validateWithConfig(input, readConfigFromEnv());
}

export async function postJournals(input: OutboundJournalBatch): Promise<OutboundJournalPostResult> {
  const config = readConfigFromEnv();
  const validation = validateWithConfig(input, config);

  if (!validation.valid) {
    return {
      status: 'error',
      batch_id: input.id,
      posted: [],
      failed: input.entries.map((entry) => ({
        journal_entry_id: entry.id,
        code: 'VALIDATION_FAILED',
        message: validation.errors.map((error) => `${error.field}: ${error.message}`).join('; ')
      }))
    };
  }

  const accessToken = await resolveAccessToken(config);
  const posted: OutboundJournalPostSuccess[] = [];
  const failed: OutboundJournalPostFailure[] = [];

  for (const entry of input.entries) {
    try {
      const payload = toZohoJournalPayload(input.id, entry, config);
      const response = await fetch(
        `${config.apiBaseUrl}/journals?organization_id=${encodeURIComponent(config.organizationId)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(payload)
        }
      );
      const body = (await response.json().catch(() => ({}))) as ZohoJournalResponse;

      if (!response.ok || body.code !== 0 || !body.journal?.journal_id) {
        failed.push({
          journal_entry_id: entry.id,
          code: toAdapterErrorCode(response.status),
          message: body.message || `Zoho Books journal create failed with HTTP ${response.status}`
        });
        continue;
      }

      posted.push({
        journal_entry_id: entry.id,
        external_reference: `zoho-books:${body.journal.journal_id}`
      });
    } catch (error) {
      failed.push({
        journal_entry_id: entry.id,
        code: 'SOURCE_UNREACHABLE',
        message: error instanceof Error ? error.message : 'Zoho Books posting failed'
      });
    }
  }

  return {
    status: failed.length === 0 ? 'ok' : posted.length > 0 ? 'partial' : 'error',
    batch_id: input.id,
    posted,
    failed
  };
}

export async function healthcheck(): Promise<AdapterHealthcheckResult> {
  const checkedAt = new Date().toISOString();

  try {
    const config = readConfigFromEnv();
    const validation = validateConfig(config);
    if (!validation.valid) {
      return {
        status: 'error',
        code: 'AUTH_FAILED',
        message: validation.errors.map((error) => `${error.field}: ${error.message}`).join('; '),
        checked_at: checkedAt
      };
    }

    const startedAt = Date.now();
    const accessToken = await resolveAccessToken(config);
    const response = await fetch(
      `${config.apiBaseUrl}/organizations?organization_id=${encodeURIComponent(config.organizationId)}`,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          'content-type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      return {
        status: 'error',
        code: toAdapterErrorCode(response.status),
        message: `Zoho Books healthcheck failed with HTTP ${response.status}`,
        checked_at: checkedAt
      };
    }

    return {
      status: 'ok',
      latency_ms: Date.now() - startedAt,
      checked_at: checkedAt
    };
  } catch (error) {
    return {
      status: 'error',
      code: 'SOURCE_UNREACHABLE',
      message: error instanceof Error ? error.message : 'Zoho Books healthcheck failed',
      checked_at: checkedAt
    };
  }
}

export function toZohoJournalPayload(
  batchId: string,
  entry: OutboundJournalEntry,
  config: ZohoBooksConfig
) {
  return {
    journal_date: entry.generated_at.slice(0, 10),
    reference_number: entry.source_id ?? entry.id,
    notes: `Ledgerise ${entry.entry_type} journal ${entry.id} for transaction ${entry.transaction_id}`,
    journal_type: 'both',
    status: config.status,
    line_items: entry.lines.map((line) => ({
      account_id: config.accountMap[line.account_code],
      description: [
        `Ledgerise batch ${batchId}`,
        entry.transaction_type,
        entry.product_line,
        entry.product_biller
      ].filter(Boolean).join(' | '),
      amount: line.amount / config.amountScale,
      debit_or_credit: line.side
    }))
  };
}

function validateWithConfig(
  input: OutboundJournalBatch,
  config: ZohoBooksConfig
): AdapterValidationResult {
  const errors: AdapterValidationError[] = [...validateConfig(config).errors];

  if (!input.id) errors.push({ field: 'id', message: 'Batch id is required' });
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    errors.push({ field: 'entries', message: 'At least one journal entry is required' });
    return { valid: false, errors };
  }

  input.entries.forEach((entry, entryIndex) => {
    const prefix = `entries.${entryIndex}`;
    if (!entry.id) errors.push({ field: `${prefix}.id`, message: 'Journal entry id is required' });
    if (!entry.generated_at) {
      errors.push({ field: `${prefix}.generated_at`, message: 'Generated timestamp is required' });
    }
    if (!Array.isArray(entry.lines) || entry.lines.length < 2) {
      errors.push({ field: `${prefix}.lines`, message: 'At least two journal lines are required' });
      return;
    }

    const totals = new Map<string, { debit: number; credit: number }>();
    entry.lines.forEach((line, lineIndex) => {
      const linePrefix = `${prefix}.lines.${lineIndex}`;
      if (!config.accountMap[line.account_code]) {
        errors.push({
          field: `${linePrefix}.account_code`,
          message: `No Zoho Books account id mapped for Ledgerise account ${line.account_code}`
        });
      }
      if (!Number.isInteger(line.amount) || line.amount <= 0) {
        errors.push({ field: `${linePrefix}.amount`, message: 'Line amount must be a positive integer' });
      }

      const total = totals.get(line.currency) ?? { debit: 0, credit: 0 };
      total[line.side] += line.amount;
      totals.set(line.currency, total);
    });

    for (const [currency, total] of totals) {
      if (total.debit !== total.credit) {
        errors.push({
          field: `${prefix}.lines`,
          message: `Debits and credits do not balance for ${currency}`,
          raw_value: total
        });
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateConfig(config: ZohoBooksConfig): AdapterValidationResult {
  const errors: AdapterValidationError[] = [];

  if (!config.organizationId) {
    errors.push({ field: 'ZOHO_BOOKS_ORGANIZATION_ID', message: 'Zoho Books organization id is required' });
  }
  if (!config.accessToken && !(config.refreshToken && config.clientId && config.clientSecret)) {
    errors.push({
      field: 'ZOHO_BOOKS_ACCESS_TOKEN',
      message: 'Set an access token or refresh token credentials'
    });
  }
  if (!Number.isFinite(config.amountScale) || config.amountScale <= 0) {
    errors.push({ field: 'ZOHO_BOOKS_AMOUNT_SCALE', message: 'Amount scale must be greater than zero' });
  }
  if (!isRecord(config.accountMap) || Object.keys(config.accountMap).length === 0) {
    errors.push({
      field: 'ZOHO_BOOKS_ACCOUNT_MAP_JSON',
      message: 'Account map JSON must map Ledgerise account codes to Zoho Books account ids'
    });
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

async function resolveAccessToken(config: ZohoBooksConfig): Promise<string> {
  if (config.accessToken) return config.accessToken;

  const body = new URLSearchParams({
    refresh_token: config.refreshToken ?? '',
    client_id: config.clientId ?? '',
    client_secret: config.clientSecret ?? '',
    grant_type: 'refresh_token'
  });
  const response = await fetch(`${config.accountsBaseUrl}/oauth/v2/token`, {
    method: 'POST',
    body
  });
  const token = (await response.json().catch(() => ({}))) as ZohoTokenResponse;

  if (!response.ok || !token.access_token) {
    throw new Error(token.error_description || token.error || 'Zoho OAuth token refresh failed');
  }

  return token.access_token;
}

function readConfigFromEnv(): ZohoBooksConfig {
  return {
    organizationId: process.env.ZOHO_BOOKS_ORGANIZATION_ID ?? '',
    accessToken: process.env.ZOHO_BOOKS_ACCESS_TOKEN,
    refreshToken: process.env.ZOHO_BOOKS_REFRESH_TOKEN,
    clientId: process.env.ZOHO_BOOKS_CLIENT_ID,
    clientSecret: process.env.ZOHO_BOOKS_CLIENT_SECRET,
    accountsBaseUrl: process.env.ZOHO_ACCOUNTS_BASE_URL ?? accountsBaseUrl(process.env.ZOHO_BOOKS_DC),
    apiBaseUrl: process.env.ZOHO_BOOKS_API_BASE_URL ?? apiBaseUrl(process.env.ZOHO_BOOKS_DC),
    accountMap: parseJsonMap(process.env.ZOHO_BOOKS_ACCOUNT_MAP_JSON),
    amountScale: Number(process.env.ZOHO_BOOKS_AMOUNT_SCALE ?? 100),
    status: process.env.ZOHO_BOOKS_JOURNAL_STATUS === 'published' ? 'published' : 'draft'
  };
}

function apiBaseUrl(dc: string | undefined): string {
  const host = {
    eu: 'www.zohoapis.eu',
    in: 'www.zohoapis.in',
    au: 'www.zohoapis.com.au',
    jp: 'www.zohoapis.jp',
    ca: 'www.zohoapis.ca',
    cn: 'www.zohoapis.com.cn',
    sa: 'www.zohoapis.sa',
    com: 'www.zohoapis.com'
  }[dc ?? 'com'] ?? 'www.zohoapis.com';

  return `https://${host}/books/v3`;
}

function accountsBaseUrl(dc: string | undefined): string {
  const host = {
    eu: 'accounts.zoho.eu',
    in: 'accounts.zoho.in',
    au: 'accounts.zoho.com.au',
    jp: 'accounts.zoho.jp',
    ca: 'accounts.zohocloud.ca',
    cn: 'accounts.zoho.com.cn',
    sa: 'accounts.zoho.sa',
    com: 'accounts.zoho.com'
  }[dc ?? 'com'] ?? 'accounts.zoho.com';

  return `https://${host}`;
}

function parseJsonMap(value: string | undefined): Record<string, string> {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (item): item is [string, string] => typeof item[1] === 'string' && item[1].trim().length > 0
      )
    );
  } catch {
    return {};
  }
}

function toAdapterErrorCode(status: number): AdapterErrorCode {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'MALFORMED_PAYLOAD';
  return 'SOURCE_UNREACHABLE';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}
