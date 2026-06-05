import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  MappingValidationError,
  type MappingService,
  type NewMappingRule,
  type UpdateMappingRule,
} from '@ledgerise/core-mapping';

import { type AuthPrincipal, requireRole } from '../middleware/auth.js';
import {
  isRecord,
  readJsonBody,
  readNullableString,
  readNumber,
  readString,
  sendJson,
} from '../lib/http.js';

interface MappingRouteDeps {
  mappingService: MappingService;
  dashboardPrincipal: AuthPrincipal;
  getOperatorId: (request: IncomingMessage) => string;
}

export async function handleMappingRequest<T>(
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

export async function handleMappingRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: MappingRouteDeps
): Promise<boolean> {
  const { mappingService, dashboardPrincipal, getOperatorId } = deps;

  if (request.method === 'GET' && url.pathname === '/api/mapping-rules') {
    sendJson(response, 200, {
      records: await mappingService.listMappingRules(getOperatorId(request))
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/mapping-rules') {
    if (!requireRole(dashboardPrincipal, response, ['admin', 'finance'])) return true;
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
    }
    const result = await handleMappingRequest(response, () =>
      mappingService.createMappingRule(getOperatorId(request), toMappingRuleInput(body.value))
    );
    if (result) sendJson(response, 201, { record: result });
    return true;
  }

  const mappingRuleMatch = /^\/api\/mapping-rules\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'PATCH' && mappingRuleMatch) {
    if (!requireRole(dashboardPrincipal, response, ['admin', 'finance'])) return true;
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
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
    return true;
  }

  const mappingRuleStatusMatch = /^\/api\/mapping-rules\/([^/]+)\/(activate|deactivate)$/.exec(url.pathname);
  if (request.method === 'POST' && mappingRuleStatusMatch) {
    if (!requireRole(dashboardPrincipal, response, ['admin', 'finance'])) return true;
    const ruleId = decodeURIComponent(mappingRuleStatusMatch[1] ?? '');
    const status = mappingRuleStatusMatch[2] === 'activate' ? 'active' : 'inactive';
    const result = await mappingService.setMappingRuleStatus(getOperatorId(request), ruleId, status);
    if (!result) {
      sendJson(response, 404, { status: 'error', code: 'MAPPING_RULE_NOT_FOUND', message: 'Mapping rule not found' });
      return true;
    }
    sendJson(response, 200, { record: result });
    return true;
  }

  return false;
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
