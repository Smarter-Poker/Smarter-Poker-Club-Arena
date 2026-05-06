/**
 * Pure helper functions for the engine WebSocket transport.
 * Kept in their own module so they can be unit-tested without pulling in
 * the full EngineWebSocketServer class (which at import-time initializes
 * Supabase and refuses to load without a service role key).
 */

/**
 * Parse `/ws/table/:tableId` and reject anything else. Returns the tableId
 * lowercased, or null if the path is malformed / doesn't match the route.
 */
export function parseTableIdFromPath(pathname: string | undefined): string | null {
  if (!pathname) return null;
  const m =
    /^\/ws\/table\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(
      pathname
    );
  return m ? m[1].toLowerCase() : null;
}

/**
 * Extract the Bearer JWT from a Sec-WebSocket-Protocol header. Accepts
 * either a raw comma-separated string or the array-form some proxies pass.
 * Returns the token if it matches the three-segment JWT shape; null otherwise.
 */
export function extractBearerToken(
  rawProtocolHeader: string | string[] | undefined
): string | null {
  if (!rawProtocolHeader) return null;
  const joined = Array.isArray(rawProtocolHeader) ? rawProtocolHeader.join(',') : rawProtocolHeader;
  const parts = joined
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bearerIdx = parts.findIndex((p) => p.toLowerCase() === 'bearer');
  if (bearerIdx === -1) return null;
  const next = parts[bearerIdx + 1];
  if (!next) return null;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(next)) return null;
  return next;
}
