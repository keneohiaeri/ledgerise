export type ParsedQuery<T> =
  | { ok: true; value: T }
  | { ok: false; error: { status: 'error'; code: string; message: string } };

export function parsePagination(url: URL): ParsedQuery<{ limit: number; offset: number }> {
  const limit = getIntegerQueryParam(url, 'limit', 100);
  const offset = getIntegerQueryParam(url, 'offset', 0);

  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return invalidQuery('Query parameter "limit" must be an integer from 1 to 500');
  }

  if (!Number.isInteger(offset) || offset < 0) {
    return invalidQuery('Query parameter "offset" must be an integer greater than or equal to 0');
  }

  return { ok: true, value: { limit, offset } };
}

export function validateDateRange(
  occurredFrom: string | undefined,
  occurredTo: string | undefined
): ParsedQuery<undefined> {
  if (occurredFrom && Number.isNaN(Date.parse(occurredFrom))) {
    return invalidQuery('Query parameter "occurred_from" must be an ISO 8601 timestamp');
  }

  if (occurredTo && Number.isNaN(Date.parse(occurredTo))) {
    return invalidQuery('Query parameter "occurred_to" must be an ISO 8601 timestamp');
  }

  if (occurredFrom && occurredTo && occurredFrom > occurredTo) {
    return invalidQuery('"occurred_from" must be before or equal to "occurred_to"');
  }

  return { ok: true, value: undefined };
}

export function getIntegerQueryParam(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  return value !== null ? parseInt(value, 10) : fallback;
}

export function getQueryParam(url: URL, name: string): string | undefined {
  return url.searchParams.get(name) ?? undefined;
}

export function invalidQuery(message: string): ParsedQuery<never> {
  return { ok: false, error: { status: 'error', code: 'INVALID_QUERY', message } };
}
