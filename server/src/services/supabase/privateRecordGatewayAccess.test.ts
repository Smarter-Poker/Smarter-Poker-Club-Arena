import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createPrivateRecordGatewayAccess,
  privateRecordGatewaySourceReady,
  PRIVATE_RECORD_GATEWAY_API_URL,
  PRIVATE_RECORD_GATEWAY_PUBLISHABLE_KEY,
} from './privateRecordGatewayAccess.js';
const environment = {
  SUPABASE_URL: PRIVATE_RECORD_GATEWAY_API_URL,
  SUPABASE_PUBLISHABLE_KEY: PRIVATE_RECORD_GATEWAY_PUBLISHABLE_KEY,
};
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
describe('gateway-only actor-bound read access', () => {
  it('requires exact public configuration and refuses any service key', () => {
    for (const patch of [
      { SUPABASE_SERVICE_ROLE_KEY: 'broad-service-capability' },
      { SUPABASE_PUBLISHABLE_KEY: 'eyJservice-role' },
      { SUPABASE_URL: 'https://another-project.supabase.co' },
    ])
      expect(() => createPrivateRecordGatewayAccess({ ...environment, ...patch })).toThrow();
  });
  it('uses only public key, actor JWT and exact read-only RPCs without shared actor state', async () => {
    const requests: { path: string; token: string | null; body: unknown }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const headers = new Headers(init?.headers);
      const token = headers.get('authorization');
      expect(headers.get('apikey')).toBe(PRIVATE_RECORD_GATEWAY_PUBLISHABLE_KEY);
      expect(init?.redirect).toBe('error');
      requests.push({ path, token, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === '/auth/v1/user')
        return reply({ id: token === 'Bearer actor-one' ? 'one' : 'two' });
      return reply(true);
    });
    const access = createPrivateRecordGatewayAccess(environment, { fetch });
    expect(
      await Promise.all([
        access.authorize('actor-one', 'one', 'club-roster:fixture-one'),
        access.authorize('actor-two', 'two', 'member-record:fixture-two'),
      ])
    ).toEqual([true, true]);
    expect(requests.filter((r) => r.path.includes('can_subscribe'))).toEqual(
      expect.arrayContaining([
        {
          path: '/rest/v1/rpc/ca_club_roster_can_subscribe',
          token: 'Bearer actor-one',
          body: { topic: 'club-roster:fixture-one' },
        },
        {
          path: '/rest/v1/rpc/ca_member_record_can_subscribe',
          token: 'Bearer actor-two',
          body: { topic: 'member-record:fixture-two' },
        },
      ])
    );
    expect(await access.authorize('actor-one', 'two', 'member-record:foreign')).toBe(false);
    expect(requests.every((r) => r.token !== null)).toBe(true);
    expect(
      requests.every((r) => r.path === '/auth/v1/user' || r.path.startsWith('/rest/v1/rpc/'))
    ).toBe(true);
  });
  it('preserves definitive auth/session rejection and treats outages as unknown', async () => {
    const authenticate = (responses: Response[]) =>
      createPrivateRecordGatewayAccess(environment, {
        fetch: vi.fn(async () => responses.shift()!),
      }).authenticate('actor');
    expect(await authenticate([reply({ code: 'bad_jwt' }, 401)])).toEqual({
      denied: 'invalid',
      code: 'bad_jwt',
    });
    expect(await authenticate([reply({ id: 'one' }), reply(false)])).toEqual({
      denied: 'invalid',
      code: 'session_not_found',
    });
    expect(await authenticate([reply({ code: 'unavailable' }, 503)])).toEqual({
      denied: 'unavailable',
      code: 'unavailable',
    });
    expect(await authenticate([reply({ id: 'one' }), reply({ message: 'not boolean' })])).toEqual({
      denied: 'unavailable',
      code: 'session_check_unavailable',
    });
  });
  it('retries only bounded pre-execution PGRST 503s', async () => {
    const responses = [reply({ id: 'one' }), reply({ code: 'PGRST002' }, 503), reply(true)];
    const fetch = vi.fn(async () => responses.shift()!);
    const wait = vi.fn(async () => {});
    expect(
      await createPrivateRecordGatewayAccess(environment, { fetch, wait }).authenticate('actor')
    ).toEqual({ userId: 'one' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledWith(300);
    for (const data of [{ code: 'OTHER503' }, { message: 'unknown' }]) {
      const raw = vi.fn(async () => reply(data, 503));
      expect(
        await createPrivateRecordGatewayAccess(environment, { fetch: raw, wait }).authenticate(
          'actor'
        )
      ).toMatchObject({ denied: 'unavailable' });
      expect(raw).toHaveBeenCalledTimes(1);
    }
    const network = vi.fn(async () => {
      throw Error('network');
    });
    expect(
      await createPrivateRecordGatewayAccess(environment, { fetch: network, wait }).authenticate(
        'actor'
      )
    ).toMatchObject({ denied: 'unavailable' });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('queries readiness only on the supplied dedicated raw session', async () => {
    const query = vi.fn(async () => ({ rows: [{ ready: true }] }));
    const client = { query } as any;
    expect(await privateRecordGatewaySourceReady(client)).toBe(true);
    expect(query).toHaveBeenCalledWith(
      'SELECT public.fn_private_record_transport_ready() AS ready'
    );
    query.mockResolvedValueOnce({ rows: [{ ready: false }] });
    expect(await privateRecordGatewaySourceReady(client)).toBe(false);
    query.mockRejectedValueOnce(Error('database unavailable'));
    await expect(privateRecordGatewaySourceReady(client)).rejects.toThrow('database unavailable');
  });
  it('bounds an unresponsive fetch and never turns it into session revocation', async () => {
    const access = createPrivateRecordGatewayAccess(environment, {
      fetch: vi.fn(() => new Promise<Response>(() => {})),
      timeoutMs: 5,
    });
    expect(await access.authenticate('actor')).toMatchObject({ denied: 'unavailable' });
  });
  it('gateway entry never imports engine privileged client/session/readiness modules', () => {
    const source = readFileSync(new URL('../../privateRecordGateway.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/supabase\/client|PlayerSessionAccess|privateRecordTransportReady/);
    expect(source).toContain('createPrivateRecordGatewayAccess');
  });
});
