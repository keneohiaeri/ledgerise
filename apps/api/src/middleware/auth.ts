import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { getHeader, isRecord, sendJson } from '../lib/http.js';

export type UserRole = 'admin' | 'finance' | 'auditor';
export type UserStatus = 'invited' | 'active' | 'disabled';

export interface AccessUser {
  id: string;
  operatorId: string;
  email: string;
  displayName?: string;
  role: UserRole;
  status: UserStatus;
  invitedAt?: string;
  lastLoginAt?: string;
  passwordHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthPrincipal {
  userId: string;
  operatorId: string;
  email: string;
  role: UserRole;
}

export const userRoles = new Set<string>(['admin', 'finance', 'auditor']);
export const userStatuses = new Set<string>(['invited', 'active', 'disabled']);

export function signAuthToken(user: AccessUser): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: user.id,
    operator_id: user.operatorId,
    email: user.email,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60
  };
  const encodedHeader = encodeTokenPart(header);
  const encodedPayload = encodeTokenPart(payload);
  const signature = signTokenParts(encodedHeader, encodedPayload);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifyAuthToken(request: IncomingMessage): AuthPrincipal | null {
  const authorization = getHeader(request.headers.authorization);
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
  if (!token) return null;

  const [encodedHeader, encodedPayload, signature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !signature) return null;

  const expectedSignature = signTokenParts(encodedHeader, encodedPayload);
  if (!constantTimeEqual(signature, expectedSignature)) return null;

  const payload = decodeTokenPart(encodedPayload);
  if (!isRecord(payload)) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.operator_id !== 'string' ||
    typeof payload.email !== 'string' ||
    typeof payload.role !== 'string' ||
    !userRoles.has(payload.role)
  ) {
    return null;
  }

  return {
    userId: payload.sub,
    operatorId: payload.operator_id,
    email: payload.email,
    role: payload.role as UserRole
  };
}

export function requireRole(
  principal: AuthPrincipal,
  response: ServerResponse,
  allowed: UserRole[]
): boolean {
  if (allowed.includes(principal.role)) return true;
  sendJson(response, 403, {
    status: 'error',
    code: 'FORBIDDEN',
    message: `Your role (${principal.role}) does not have permission for this action`
  });
  return false;
}

function encodeTokenPart(input: unknown): string {
  return Buffer.from(JSON.stringify(input), 'utf8').toString('base64url');
}

function decodeTokenPart(input: string): unknown {
  try {
    return JSON.parse(Buffer.from(input, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function signTokenParts(encodedHeader: string, encodedPayload: string): string {
  return createHmac('sha256', process.env.AUTH_TOKEN_SECRET ?? 'ledgerise-local-development-secret')
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
