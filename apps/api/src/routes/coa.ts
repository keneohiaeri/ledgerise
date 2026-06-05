import type { IncomingMessage, ServerResponse } from 'node:http';

import { type MappingService } from '@ledgerise/core-mapping';

import { type AuthPrincipal, requireRole } from '../middleware/auth.js';
import { isRecord, readJsonBody, sendJson } from '../lib/http.js';
import { handleMappingRequest } from './mapping.js';

interface CoaRouteDeps {
  mappingService: MappingService;
  dashboardPrincipal: AuthPrincipal;
  getOperatorId: (request: IncomingMessage) => string;
}

export async function handleCoaRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: CoaRouteDeps
): Promise<boolean> {
  const { mappingService, dashboardPrincipal, getOperatorId } = deps;

  if (request.method === 'GET' && url.pathname === '/api/coa') {
    sendJson(response, 200, {
      records: await mappingService.listChartAccounts(getOperatorId(request))
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/coa/import') {
    if (!requireRole(dashboardPrincipal, response, ['admin', 'finance'])) return true;
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
    }
    const accounts = isRecord(body.value) ? body.value.accounts : undefined;
    if (!Array.isArray(accounts)) {
      sendJson(response, 400, {
        status: 'error',
        code: 'INVALID_BODY',
        message: 'Body must include accounts array'
      });
      return true;
    }
    const result = await handleMappingRequest(response, () =>
      mappingService.importChartAccounts(getOperatorId(request), accounts)
    );
    if (result) sendJson(response, 200, { records: result });
    return true;
  }

  const coaAccountMatch = /^\/api\/coa\/([^/]+)$/.exec(url.pathname);
  if (coaAccountMatch) {
    const code = decodeURIComponent(coaAccountMatch[1] ?? '');

    if (request.method === 'PATCH') {
      if (!requireRole(dashboardPrincipal, response, ['admin', 'finance'])) return true;
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
        return true;
      }
      const active = isRecord(body.value) && typeof body.value.active === 'boolean' ? body.value.active : null;
      if (active === null) {
        sendJson(response, 400, { status: 'error', code: 'INVALID_BODY', message: 'Body must include active (boolean)' });
        return true;
      }
      const updated = await mappingService.updateChartAccount(getOperatorId(request), code, { active });
      if (!updated) {
        sendJson(response, 404, { status: 'error', code: 'NOT_FOUND', message: 'Account not found' });
        return true;
      }
      sendJson(response, 200, { record: updated });
      return true;
    }

    if (request.method === 'DELETE') {
      if (!requireRole(dashboardPrincipal, response, ['admin', 'finance'])) return true;
      const deleted = await mappingService.deleteChartAccount(getOperatorId(request), code);
      if (!deleted) {
        sendJson(response, 404, { status: 'error', code: 'NOT_FOUND', message: 'Account not found' });
        return true;
      }
      sendJson(response, 200, { status: 'ok' });
      return true;
    }
  }

  return false;
}
