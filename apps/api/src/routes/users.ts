import type { IncomingMessage, ServerResponse } from 'node:http';

import { type AccessStore } from '../container.js';
import { hashPassword } from '../lib/crypto.js';
import { isRecord, readJsonBody, readString, sendJson } from '../lib/http.js';
import {
  type AuthPrincipal,
  type UserRole,
  type UserStatus,
  requireRole,
  userRoles,
  userStatuses,
} from '../middleware/auth.js';
import { toUserResponse } from './auth.js';

interface UserRouteDeps {
  accessStore: AccessStore;
  dashboardPrincipal: AuthPrincipal;
  getOperatorId: (request: IncomingMessage) => string;
}

export async function handleUserRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: UserRouteDeps
): Promise<boolean> {
  const { accessStore, dashboardPrincipal, getOperatorId } = deps;

  if (request.method === 'GET' && url.pathname === '/api/users') {
    sendJson(response, 200, {
      records: (await accessStore.listUsers(getOperatorId(request))).map(toUserResponse)
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/users/invitations') {
    if (!requireRole(dashboardPrincipal, response, ['admin'])) return true;
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
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
      return true;
    }

    const user = await accessStore.inviteUser({
      operatorId: getOperatorId(request),
      email,
      displayName: readString(payload, 'display_name') ?? readString(payload, 'name'),
      role,
      passwordHash: password ? hashPassword(password) : undefined
    });
    sendJson(response, 201, { record: toUserResponse(user) });
    return true;
  }

  const userMatch = /^\/api\/users\/([^/]+)$/.exec(url.pathname);
  if (userMatch && request.method === 'PATCH') {
    if (!requireRole(dashboardPrincipal, response, ['admin'])) return true;
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
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
      return true;
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
      return true;
    }

    sendJson(response, 200, { record: toUserResponse(user) });
    return true;
  }

  return false;
}

function readUserRole(input: unknown): UserRole | undefined {
  return typeof input === 'string' && userRoles.has(input) ? (input as UserRole) : undefined;
}

function readUserStatus(input: unknown): UserStatus | undefined {
  return typeof input === 'string' && userStatuses.has(input) ? (input as UserStatus) : undefined;
}
