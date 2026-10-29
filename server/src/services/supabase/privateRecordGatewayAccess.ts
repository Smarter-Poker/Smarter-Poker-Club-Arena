import { verifySupabaseToken, type TokenVerdict } from '../../transport/wsHelpers.js';

export const PRIVATE_RECORD_GATEWAY_API_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
export const PRIVATE_RECORD_GATEWAY_PUBLISHABLE_KEY =
  'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const preExecution = new Set(['PGRST001', 'PGRST002', 'PGRST003']);
const retries = [300, 1200];
type JsonResult = { status: number; data: any };

/** No service capability, shared engine singleton or mutable actor client. */
export function createPrivateRecordGatewayAccess(
  environment: Record<string, string | undefined>,
  options: {
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    wait?: (ms: number) => Promise<void>;
  } = {}
) {
  if (
    environment.SUPABASE_SERVICE_ROLE_KEY ||
    environment.SUPABASE_URL !== PRIVATE_RECORD_GATEWAY_API_URL ||
    environment.SUPABASE_PUBLISHABLE_KEY !== PRIVATE_RECORD_GATEWAY_PUBLISHABLE_KEY
  )
    throw new Error('gateway requires only its pinned publishable API configuration');
  const fetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  async function request(
    path: string,
    token?: string,
    body: Record<string, unknown> = {}
  ): Promise<JsonResult> {
    // All paths and methods originate below; no generic query/write API escapes.
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result: JsonResult = await Promise.race([
          (async () => {
            const response = await fetch(`${PRIVATE_RECORD_GATEWAY_API_URL}${path}`, {
              method: path === '/auth/v1/user' ? 'GET' : 'POST',
              headers: {
                apikey: PRIVATE_RECORD_GATEWAY_PUBLISHABLE_KEY,
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                'Content-Type': 'application/json',
              },
              ...(path === '/auth/v1/user' ? {} : { body: JSON.stringify(body) }),
              signal: controller.signal,
              redirect: 'error',
            });
            return { status: response.status, data: await response.json() };
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error('gateway API deadline'));
              controller.abort();
            }, timeoutMs);
          }),
        ]);
        if (
          path.startsWith('/rest/v1/rpc/') &&
          result.status === 503 &&
          preExecution.has(result.data?.code) &&
          attempt < retries.length
        ) {
          if (timer) clearTimeout(timer);
          await wait(retries[attempt]);
          continue;
        }
        return result;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  const booleanRpc = async (name: string, token?: string): Promise<boolean> => {
    const result = await request(`/rest/v1/rpc/${name}`, token);
    if (result.status < 200 || result.status >= 300 || typeof result.data !== 'boolean')
      throw new Error('gateway read-only authorization unavailable');
    return result.data;
  };
  const authenticate = async (token: string): Promise<TokenVerdict> => {
    const verdict = await verifySupabaseToken(
      {
        getUser: async (jwt) => {
          const result = await request('/auth/v1/user', jwt);
          return result.status >= 200 && result.status < 300
            ? { data: { user: result.data }, error: null }
            : { data: null, error: { status: result.status, code: result.data?.code } };
        },
      },
      token
    );
    if (!verdict.userId) return verdict;
    try {
      return (await booleanRpc('fn_ca_private_record_gateway_session_live', token))
        ? verdict
        : { denied: 'invalid', code: 'session_not_found' };
    } catch {
      return { denied: 'unavailable', code: 'session_check_unavailable' };
    }
  };
  return {
    authenticate,
    authorize: async (token: string, userId: string, topic: string): Promise<boolean> => {
      const verdict = await authenticate(token);
      if (!verdict.userId && verdict.denied === 'unavailable')
        throw new Error('record authorization unavailable');
      if (verdict.userId !== userId) return false;
      const name = topic.startsWith('member-record:')
        ? 'ca_member_record_can_subscribe'
        : 'ca_club_roster_can_subscribe';
      const result = await request(`/rest/v1/rpc/${name}`, token, { topic });
      // Topic is the sole payload, while the actor stays bound to this JWT.
      if (result.status < 200 || result.status >= 300 || typeof result.data !== 'boolean')
        throw new Error('record authorization unavailable');
      return result.data;
    },
    sourceReady: () => booleanRpc('fn_ca_private_record_gateway_ready'),
  };
}
