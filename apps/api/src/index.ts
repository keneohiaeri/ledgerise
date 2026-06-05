import { createServer } from 'node:http';

import { IngestionService } from '@ledgerise/core-ingestion';
import { MappingService } from '@ledgerise/core-mapping';
import { JournalEngineService } from '@ledgerise/core-engine';
import { PostingService } from '@ledgerise/core-posting';

import {
  bootstrapAdminUser,
  bootstrapSystemSettings,
  createRepositories,
  loadSystemSettingsIntoCache,
} from './container.js';
import { sendJson } from './lib/http.js';
import { createRouter } from './router.js';

const port = Number(process.env.API_PORT ?? '3000');

type LogLevel = 'info' | 'warn' | 'error';

function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }) + '\n'
  );
}

const {
  ingestionRepository,
  mappingRepository,
  postingRepository,
  engineRepository,
  accessStore,
  defaultOperatorId,
  repositoryKind,
  pgPool,
} = await createRepositories();

await bootstrapAdminUser(accessStore, defaultOperatorId);
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

const handleRequest = createRouter({
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
});

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

server.listen(port, () => {
  log('info', 'server_start', { port, repository: repositoryKind });
});
