import type { IncomingMessage, ServerResponse } from 'node:http';

import pg from 'pg';

import {
  type SystemSettings,
  getSystemSettings,
  patchSystemSettings,
  persistSystemSettings,
} from '../container.js';
import { type AuthPrincipal, requireRole } from '../middleware/auth.js';
import {
  isRecord,
  readJsonBody,
  readNumber,
  readString,
  sendJson,
  sendText,
} from '../lib/http.js';

interface SettingsRouteDeps {
  pgPool: pg.Pool | null;
  dashboardPrincipal: AuthPrincipal;
  getOperatorId: (request: IncomingMessage) => string;
}

export async function handleSettingsRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: SettingsRouteDeps
): Promise<boolean> {
  const { pgPool, dashboardPrincipal, getOperatorId } = deps;

  if (request.method === 'GET' && url.pathname === '/api/system-settings') {
    sendJson(response, 200, { record: getSystemSettings(getOperatorId(request)) });
    return true;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/system-settings') {
    if (!requireRole(dashboardPrincipal, response, ['admin'])) return true;
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
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
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/audit-log.csv') {
    if (!requireRole(dashboardPrincipal, response, ['admin'])) return true;

    if (!pgPool) {
      sendJson(response, 503, { status: 'error', code: 'NOT_AVAILABLE', message: 'Audit log requires a database connection' });
      return true;
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
    return true;
  }

  return false;
}
