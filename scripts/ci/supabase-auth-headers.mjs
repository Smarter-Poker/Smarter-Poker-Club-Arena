/**
 * Build server-side Supabase REST headers for both API-key generations.
 *
 * Legacy service-role JWTs are valid as both `apikey` and a Bearer token.
 * Current `sb_secret_...` keys are deliberately not JWTs and Supabase rejects
 * them when sent as Authorization Bearer credentials. They still carry the
 * server role through the `apikey` header and therefore bypass RLS.
 *
 * Keep the historical SUPABASE_SERVICE_ROLE_KEY environment-variable name so
 * existing repository and GitHub configuration remains compatible while the
 * underlying credential moves to Supabase's current server-key format.
 *
 * Stage-B Data API fencing rejects unidentified traffic only on exact
 * engine-private routes. This helper still stamps Club Arena utilities as
 * ordinary service/protocol-1 traffic and drops any caller-supplied
 * authentication, actor, or tournament authority fields.
 */
export function supabaseServerHeaders(key, extra = {}) {
  if (!key) throw new Error('A Supabase server key is required');

  const reserved = new Set([
    'apikey',
    'authorization',
    'x-smarter-data-actor',
    'x-smarter-data-protocol',
    'x-smarter-tournament-id',
    'x-smarter-tournament-lease-generation',
  ]);
  const requestHeaders = Object.fromEntries(
    Object.entries(extra).filter(([name]) => !reserved.has(name.toLowerCase()))
  );

  return {
    ...requestHeaders,
    apikey: key,
    ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }),
    'x-smarter-data-actor': 'service',
    'x-smarter-data-protocol': '1',
  };
}
