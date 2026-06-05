import type { IncomingMessage, ServerResponse } from 'node:http';

import pg from 'pg';

import { type IngestionRepository, type IngestionService } from '@ledgerise/core-ingestion';
import { type MappingService } from '@ledgerise/core-mapping';
import { type JournalEngineService } from '@ledgerise/core-engine';
import { type PostingService } from '@ledgerise/core-posting';

import { type AccessStore, dbHealthCheck } from './container.js';
import { type AuthPrincipal, verifyAuthToken } from './middleware/auth.js';
import { applyCors, getHeader, sendJson } from './lib/http.js';

import { handleAuthRoutes } from './routes/auth.js';
import { handleApiKeyRoutes } from './routes/adapters.js';
import { handleCoaRoutes } from './routes/coa.js';
import { handleEngineRoutes } from './routes/engine.js';
import { handleIngestionRoutes } from './routes/ingestion.js';
import { handleMappingRoutes } from './routes/mapping.js';
import { handlePostingRoutes } from './routes/posting.js';
import { handleSettingsRoutes } from './routes/settings.js';
import { handleTransactionRoutes } from './routes/transactions.js';
import { handleUserRoutes } from './routes/users.js';

type LogFn = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;

interface RouterDeps {
  accessStore: AccessStore;
  ingestionService: IngestionService;
  ingestionRepository: IngestionRepository;
  mappingService: MappingService;
  postingService: PostingService;
  engineService: JournalEngineService;
  pgPool: pg.Pool | null;
  defaultOperatorId: string;
  repositoryKind: 'memory' | 'postgres';
  log: LogFn;
}

export function createRouter(
  deps: RouterDeps
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const {
    accessStore,
    ingestionService,
    ingestionRepository,
    mappingService,
    postingService,
    engineService,
    pgPool,
    defaultOperatorId,
    repositoryKind,
    log,
  } = deps;

  function getOperatorId(request: IncomingMessage): string {
    return (
      verifyAuthToken(request)?.operatorId ??
      getHeader(request.headers['x-operator-id']) ??
      defaultOperatorId
    );
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

  return async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
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
          await dbHealthCheck(pgPool);
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

    if (await handleAuthRoutes(request, response, url, { accessStore, getOperatorId, log })) return;

    let dashboardPrincipal: AuthPrincipal | null = null;
    if (isDashboardApiPath(url.pathname)) {
      dashboardPrincipal = await authorizeDashboardRequest(request, response);
      if (!dashboardPrincipal) return;
    }

    if (await handleIngestionRoutes(request, response, url, { ingestionService, ingestionRepository, dashboardPrincipal, getOperatorId, defaultOperatorId, log })) return;

    if (await handleUserRoutes(request, response, url, { accessStore, dashboardPrincipal: dashboardPrincipal!, getOperatorId })) return;

    if (await handleApiKeyRoutes(request, response, url, { accessStore, dashboardPrincipal: dashboardPrincipal!, getOperatorId })) return;

    if (await handleTransactionRoutes(request, response, url, { ingestionRepository, pgPool, dashboardPrincipal: dashboardPrincipal!, getOperatorId, log })) return;

    if (await handleEngineRoutes(request, response, url, { engineService, postingService, pgPool, dashboardPrincipal: dashboardPrincipal!, getOperatorId, log })) return;

    if (await handlePostingRoutes(request, response, url, { postingService })) return;

    if (await handleCoaRoutes(request, response, url, { mappingService, dashboardPrincipal: dashboardPrincipal!, getOperatorId })) return;

    if (await handleMappingRoutes(request, response, url, { mappingService, dashboardPrincipal: dashboardPrincipal!, getOperatorId })) return;

    if (await handleSettingsRoutes(request, response, url, { pgPool, dashboardPrincipal: dashboardPrincipal!, getOperatorId })) return;

    sendJson(response, 404, {
      status: 'error',
      code: 'NOT_FOUND',
      message: 'Route not found'
    });
  };
}

function isDashboardApiPath(pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  if (pathname.startsWith('/api/auth/')) return false;
  if (pathname.startsWith('/api/ingest/')) return false;
  if (pathname.startsWith('/api/posting-batches')) return false;
  if (pathname.startsWith('/api/posting-artifacts')) return false;
  return true;
}
