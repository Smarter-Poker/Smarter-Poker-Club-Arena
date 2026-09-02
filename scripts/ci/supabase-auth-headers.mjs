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
 */
export function supabaseServerHeaders(key, extra = {}) {
  if (!key) throw new Error('A Supabase server key is required');

  return {
    apikey: key,
    ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }),
    ...extra,
  };
}
