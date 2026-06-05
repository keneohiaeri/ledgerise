import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readJsonBody(
  request: IncomingMessage
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks).toString('utf8'))
    };
  } catch {
    return {
      ok: false,
      message: 'Request body must be valid JSON'
    };
  }
}

export async function readMultipartFile(
  request: IncomingMessage
): Promise<{ ok: true; content: Buffer; filename?: string } | { ok: false; message: string }> {
  const contentType = request.headers['content-type'] ?? '';
  const boundaryMatch = /boundary=([^\s;]+)/i.exec(contentType);
  const boundary = boundaryMatch?.[1];
  if (!boundary) {
    return { ok: false, message: 'Expected multipart/form-data with a file field' };
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);

  const dashBoundary = Buffer.from(`--${boundary}`);
  const headerSep = Buffer.from('\r\n\r\n');

  let pos = body.indexOf(dashBoundary);
  while (pos !== -1) {
    pos += dashBoundary.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;

    const headerEnd = body.indexOf(headerSep, pos);
    if (headerEnd === -1) break;

    const headers = body.slice(pos, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const nextBoundary = body.indexOf(dashBoundary, contentStart);
    const rawEnd = nextBoundary === -1 ? body.length : nextBoundary;
    const contentEnd =
      rawEnd >= 2 && body[rawEnd - 2] === 0x0d && body[rawEnd - 1] === 0x0a ? rawEnd - 2 : rawEnd;

    const filenameMatch = /filename="([^"]*)"/i.exec(headers);
    if (filenameMatch !== null) {
      return {
        ok: true,
        content: body.slice(contentStart, contentEnd),
        filename: filenameMatch[1] || undefined
      };
    }

    pos = nextBoundary === -1 ? -1 : nextBoundary;
  }

  return { ok: false, message: 'No file field found in multipart body' };
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*'
  });
  response.end(JSON.stringify(body));
}

export function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  headers: Record<string, string> = {}
): void {
  response.writeHead(statusCode, {
    'access-control-allow-origin': '*',
    ...headers
  });
  response.end(body);
}

export function applyCors(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
  response.setHeader(
    'access-control-allow-headers',
    'authorization,content-type,idempotency-key,x-api-key,x-operator-id,x-user-id'
  );
}

export function getHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function getClientIp(request: IncomingMessage): string {
  const forwarded = getHeader(request.headers['x-forwarded-for']);
  return forwarded?.split(',')[0]?.trim() ?? request.socket.remoteAddress ?? 'unknown';
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

export function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readNullableString(input: Record<string, unknown>, key: string): string | null | undefined {
  if (input[key] === null) return null;
  return readString(input, key);
}

export function readNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' ? value : undefined;
}

export function readStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export function getNestedString(input: unknown, path: string[]): string | undefined {
  const value = path.reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, input);
  return typeof value === 'string' ? value : undefined;
}

export function countCsvRows(content: string): number {
  const trimmed = content.trim();
  return trimmed ? trimmed.split('\n').length : 0;
}
