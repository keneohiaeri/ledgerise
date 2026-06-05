import type { IncomingMessage, ServerResponse } from 'node:http';

import { type AccessStore, type ManagedApiKey, readApiScopes } from '../container.js';
import { type AuthPrincipal, requireRole } from '../middleware/auth.js';
import { isRecord, readJsonBody, readString, sendJson } from '../lib/http.js';

interface ApiKeyRouteDeps {
  accessStore: AccessStore;
  dashboardPrincipal: AuthPrincipal;
  getOperatorId: (request: IncomingMessage) => string;
}

export async function handleApiKeyRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: ApiKeyRouteDeps
): Promise<boolean> {
  const { accessStore, dashboardPrincipal, getOperatorId } = deps;

  if (request.method === 'GET' && url.pathname === '/api/api-keys') {
    sendJson(response, 200, {
      records: (await accessStore.listApiKeys(getOperatorId(request))).map(toApiKeyResponse)
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/api-keys') {
    if (!requireRole(dashboardPrincipal, response, ['admin'])) return true;
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
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
      return true;
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
    return true;
  }

  const apiKeyRevokeMatch = /^\/api\/api-keys\/([^/]+)\/revoke$/.exec(url.pathname);
  if (apiKeyRevokeMatch && request.method === 'POST') {
    if (!requireRole(dashboardPrincipal, response, ['admin'])) return true;
    const apiKey = await accessStore.revokeApiKey({
      operatorId: getOperatorId(request),
      apiKeyId: decodeURIComponent(apiKeyRevokeMatch[1] ?? '')
    });

    if (!apiKey) {
      sendJson(response, 404, { status: 'error', code: 'API_KEY_NOT_FOUND', message: 'API key not found' });
      return true;
    }

    sendJson(response, 200, { record: toApiKeyResponse(apiKey) });
    return true;
  }

  return false;
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
