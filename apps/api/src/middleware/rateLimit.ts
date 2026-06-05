export const INGEST_RATE_LIMIT = Number(process.env.INGEST_RATE_LIMIT ?? '120');
const INGEST_RATE_WINDOW_MS = 60_000;
const ingestRateCounts = new Map<string, { count: number; windowStart: number }>();

setInterval(() => {
  const cutoff = Date.now() - INGEST_RATE_WINDOW_MS;
  for (const [key, entry] of ingestRateCounts) {
    if (entry.windowStart < cutoff) ingestRateCounts.delete(key);
  }
}, 60_000).unref();

export function checkIngestRateLimit(remoteAddr: string): boolean {
  const now = Date.now();
  const entry = ingestRateCounts.get(remoteAddr);
  if (!entry || now - entry.windowStart >= INGEST_RATE_WINDOW_MS) {
    ingestRateCounts.set(remoteAddr, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= INGEST_RATE_LIMIT) return false;
  entry.count += 1;
  return true;
}
