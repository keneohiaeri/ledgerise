import type { IncomingMessage, ServerResponse } from 'node:http';

import { type AccessStore } from '../container.js';
import { type AccessUser } from '../middleware/auth.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { isRecord, readJsonBody, readString, sendJson } from '../lib/http.js';
import { signAuthToken, verifyAuthToken } from '../middleware/auth.js';

type LogFn = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;

interface AuthRouteDeps {
  accessStore: AccessStore;
  getOperatorId: (request: IncomingMessage) => string;
  log: LogFn;
}

export function toUserResponse(user: AccessUser) {
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

export async function handleAuthRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: AuthRouteDeps
): Promise<boolean> {
  const { accessStore, getOperatorId, log } = deps;

  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
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
      return true;
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
      return true;
    }

    const loggedInUser = (await accessStore.recordLogin({ operatorId, userId: user.id })) ?? user;
    log('info', 'auth_login', { operatorId, userId: user.id, role: user.role });
    sendJson(response, 200, {
      token: signAuthToken(loggedInUser),
      expires_in_seconds: 8 * 60 * 60,
      user: toUserResponse(loggedInUser)
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/me') {
    const principal = verifyAuthToken(request);
    if (!principal) {
      sendJson(response, 401, {
        status: 'error',
        code: 'AUTHENTICATION_REQUIRED',
        message: 'A valid bearer token is required'
      });
      return true;
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
      return true;
    }

    sendJson(response, 200, { user: toUserResponse(user) });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    const principal = verifyAuthToken(request);
    if (principal) log('info', 'auth_logout', { operatorId: principal.operatorId, userId: principal.userId });
    sendJson(response, 200, { status: 'ok' });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/change-password') {
    const principal = verifyAuthToken(request);
    if (!principal) {
      sendJson(response, 401, {
        status: 'error',
        code: 'AUTHENTICATION_REQUIRED',
        message: 'A valid bearer token is required'
      });
      return true;
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
      return true;
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, { status: 'error', code: 'MALFORMED_JSON', message: body.message });
      return true;
    }

    const payload = isRecord(body.value) ? body.value : {};
    const newPassword = readString(payload, 'password') ?? readString(payload, 'new_password');
    if (!newPassword || newPassword.length < 8) {
      sendJson(response, 400, {
        status: 'error',
        code: 'INVALID_PASSWORD',
        message: 'Password must be at least 8 characters'
      });
      return true;
    }

    const updated = await accessStore.updateUser({
      operatorId: principal.operatorId,
      userId: principal.userId,
      status: 'active',
      passwordHash: hashPassword(newPassword)
    });

    if (!updated) {
      sendJson(response, 404, { status: 'error', code: 'USER_NOT_FOUND', message: 'User not found' });
      return true;
    }

    sendJson(response, 200, {
      token: signAuthToken(updated),
      expires_in_seconds: 8 * 60 * 60,
      user: toUserResponse(updated)
    });
    return true;
  }

  return false;
}
