import { beforeEach, describe, it, expect, vi } from 'vitest';
const h = vi.hoisted(() => ({
  requests: [] as any[],
  wrongLink: false,
  wrongSession: false,
  unknown: false,
  refused: false,
  absent: '',
  metadataChanged: false,
  missingCount: false,
  cleanup: 0,
  fetcher: null as any,
}));
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...original,
    createClient: (url: string, key: string, options: any) =>
      original.createClient(url, key, {
        ...options,
        global: { fetch: (...args: any[]) => h.fetcher(...args) },
      }),
  };
});
import { createClient } from '@supabase/supabase-js';
const SUBJECT_URL = process.env.SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co';
import {
  replacementBoardingAdapter,
  REPLACEMENT_BOARD,
  REPLACEMENT_OWNER,
  boardingRequest,
} from './HorseReplacementBoarding.js';
const row = {
  horseId: '8b27a10f-e57b-47d9-9af0-000000000001',
  retiredHorseId: '00000000-0000-0000-0000-000000000002',
};
const user = () => ({
  id: row.horseId,
  aud: 'authenticated',
  email: 'horse@example.invalid',
  created_at: '2026-10-25T00:00:00Z',
  user_metadata: {
    horse_creation_operation: 'patterned-retirement-20261006',
    retired_horse_id: row.retiredHorseId,
  },
});
beforeEach(() => {
  h.requests = [];
  h.wrongLink = false;
  h.wrongSession = false;
  h.unknown = false;
  h.refused = false;
  h.absent = '';
  h.metadataChanged = false;
  h.missingCount = false;
  h.cleanup = 0;
  h.fetcher = async (input: any, init: any) => {
    const url = new URL(String(input)),
      body = init?.body ? JSON.parse(String(init.body)) : null;
    h.requests.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      body,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const response = (value: any, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname === '/auth/v1/admin/users/' + row.horseId)
      return response({ ...user(), user_metadata: h.metadataChanged ? {} : user().user_metadata });
    if (url.pathname === '/rest/v1/profiles') {
      expect(url.searchParams.get('id')).toBe('eq.' + row.horseId);
      return response(
        h.absent === 'profiles'
          ? []
          : [{ id: row.horseId, is_horse: true, status: 'active', horse_status: 'available' }]
      );
    }
    if (url.pathname === '/rest/v1/ca_horse_fleet_register')
      return response(h.absent === 'register' ? [] : [{ horse_id: row.horseId, retired_at: null }]);
    if (url.pathname === '/rest/v1/ca_horse_active_roster')
      return response(h.absent === 'roster' ? [] : [{ horse_id: row.horseId }]);
    if (url.pathname === '/rest/v1/clubs') {
      expect(url.searchParams.get('id')).toBe('eq.' + REPLACEMENT_BOARD);
      return response([
        {
          id: REPLACEMENT_BOARD,
          owner_id: REPLACEMENT_OWNER,
          requires_approval: false,
          status: 'active',
          lifecycle_status: 'active',
          max_members: 500,
          settlement_locked: false,
        },
      ]);
    }
    if (url.pathname === '/rest/v1/club_members') {
      expect(init?.method).toBe('HEAD');
      expect(url.searchParams.get('club_id')).toBe('eq.' + REPLACEMENT_BOARD);
      expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
      return new Response(null, {
        status: 200,
        headers: h.missingCount ? {} : { 'content-range': '0-0/434' },
      });
    }
    if (url.pathname === '/rest/v1/club_join_idempotency') {
      expect(url.searchParams.get('user_id')).toBe('eq.' + row.horseId);
      expect(url.searchParams.get('request_id')).toBe('eq.' + boardingRequest(row));
      return response([]);
    }
    if (url.pathname === '/auth/v1/admin/generate_link')
      return response({
        ...user(),
        id: h.wrongLink ? 'other' : row.horseId,
        action_link: 'https://boarding.invalid/link',
        email_otp: 'unused',
        hashed_token: 'original-token',
        redirect_to: 'https://boarding.invalid',
        verification_type: 'magiclink',
      });
    if (url.pathname === '/auth/v1/verify')
      return response({
        access_token: 'subject-token',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'subject-refresh',
        user: { ...user(), id: h.wrongSession ? 'other' : row.horseId },
      });
    if (url.pathname === '/auth/v1/user') return response(user());
    if (url.pathname === '/auth/v1/logout') {
      h.cleanup++;
      expect(url.searchParams.get('scope')).toBe('local');
      return response({});
    }
    if (url.pathname === '/rest/v1/rpc/fn_join_club_atomic') {
      expect(body).toEqual({
        p_identifier: REPLACEMENT_BOARD,
        p_request_id: boardingRequest(row),
        p_referral_code: 'kingfish',
      });
      if (h.unknown) throw TypeError('join ack lost');
      return response(
        h.refused
          ? { success: false, code: 'membership_blocked' }
          : {
              success: true,
              status: 'active',
              club: { id: REPLACEMENT_BOARD },
              membership: {
                user_id: row.horseId,
                club_id: REPLACEMENT_BOARD,
                invited_by: REPLACEMENT_OWNER,
                agent_id: null,
              },
            }
      );
    }
    throw Error('Unexpected external request ' + url.pathname);
  };
});
function adapter() {
  return replacementBoardingAdapter(
    createClient(SUBJECT_URL, 'isolated-service-key', {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    SUBJECT_URL
  );
}
describe('real Supabase original subject boarding transport', () => {
  it('reads actual DSS settings and its exact HEAD count before any subject session', async () => {
    await expect(adapter().board()).resolves.toEqual({ count: 434, maximum: 500 });
    expect(h.requests.map((r) => [r.path, r.method])).toEqual([
      ['/rest/v1/clubs', 'GET'],
      ['/rest/v1/club_members', 'HEAD'],
    ]);
  });
  it('refuses an unavailable HEAD count without a session or join write', async () => {
    h.missingCount = true;
    await expect(adapter().board()).rejects.toThrow('DSS capacity read unavailable');
    expect(h.requests.every((r) => ['GET', 'HEAD'].includes(r.method))).toBe(true);
    expect(h.requests.some((r) => r.path.startsWith('/auth/'))).toBe(false);
  });

  it('verifies the original Auth metadata, eligible profile and both canonical roster owners with real scoped reads', async () => {
    await adapter().verify(row);
    expect(h.requests.filter((r) => r.path.startsWith('/rest/'))).toHaveLength(3);
    expect(h.requests.every((r) => r.method === 'GET')).toBe(true);
  });
  it.each(['profiles', 'register', 'roster'])(
    'refuses absent %s proof without a session or write',
    async (absent) => {
      h.absent = absent;
      await expect(adapter().verify(row)).rejects.toThrow();
      expect(h.requests.every((r) => r.method === 'GET')).toBe(true);
    }
  );
  it('refuses changed original Auth metadata before reading profile or creating a session', async () => {
    h.metadataChanged = true;
    await expect(adapter().verify(row)).rejects.toThrow('metadata changed');
    expect(h.requests).toHaveLength(1);
  });
  it('reads only the original user/request receipt, never a latest unrelated receipt', async () => {
    expect(await adapter().receipt(row.horseId, boardingRequest(row))).toBe(null);
    expect(h.requests).toHaveLength(1);
  });
  it('creates only the subject login, passes original identity and signs out locally', async () => {
    expect((await adapter().join(row, boardingRequest(row))).success).toBe(true);
    expect(h.cleanup).toBe(1);
    expect(h.requests.filter((r) => r.path.includes('/rpc/'))).toHaveLength(1);
    expect(h.requests.find((r) => r.path.includes('/rpc/')).authorization).toBe(
      'Bearer subject-token'
    );
    expect(h.requests.some((r) => r.method === 'PATCH' || r.path === '/auth/v1/admin/users')).toBe(
      false
    );
  });
  it('refuses another link identity before any subject login or membership request', async () => {
    h.wrongLink = true;
    await expect(adapter().join(row, boardingRequest(row))).rejects.toThrow('link mismatch');
    expect(h.requests.some((r) => r.path === '/auth/v1/verify' || r.path.includes('/rpc/'))).toBe(
      false
    );
  });
  it('refuses wrong verified session and cleans up locally', async () => {
    h.wrongSession = true;
    await expect(adapter().join(row, boardingRequest(row))).rejects.toThrow('session mismatch');
    expect(h.requests.some((r) => r.path.includes('/rpc/'))).toBe(false);
    expect(h.cleanup).toBe(1);
  });
  it('unknown join acknowledgement does not create a second request and cleans up subject', async () => {
    h.unknown = true;
    await expect(adapter().join(row, boardingRequest(row))).rejects.toBeDefined();
    expect(h.requests.filter((r) => r.path.includes('/rpc/'))).toHaveLength(1);
    expect(h.cleanup).toBe(1);
  });
  it('returns the real explicit refusal without reporting success', async () => {
    h.refused = true;
    expect(await adapter().join(row, boardingRequest(row))).toMatchObject({
      success: false,
      code: 'membership_blocked',
    });
    expect(h.cleanup).toBe(1);
  });
});
