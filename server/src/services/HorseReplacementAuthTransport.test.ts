import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  users: new Map<string, any>(),
  profiles: new Map<string, any>(),
  requests: [] as Array<{ path: string; method: string; body: any }>,
  grants: 0,
  loseAck: false,
  profileError: false,
  lookupUnknown: false,
}));
vi.mock('./supabase.js', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return {
    supabase: createClient('https://replacement.invalid', 'isolated-test-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: async (input, init) => {
          const url = new URL(String(input)),
            method = init?.method ?? 'GET',
            body = init?.body ? JSON.parse(String(init.body)) : null;
          h.requests.push({ path: url.pathname, method, body });
          const response = (data: any, status = 200) =>
            new Response(JSON.stringify(data), {
              status,
              headers: { 'content-type': 'application/json' },
            });
          if (url.pathname.startsWith('/auth/v1/admin/users/')) {
            if (method === 'DELETE')
              throw Error('Accepted replacement account must never be deleted');
            if (h.lookupUnknown)
              return response({ code: 'unexpected_failure', msg: 'lookup unknown' }, 503);
            const id = url.pathname.split('/').at(-1)!;
            return h.users.has(id)
              ? response(h.users.get(id))
              : response({ code: 'user_not_found', msg: 'User not found' }, 404);
          }
          if (url.pathname === '/auth/v1/admin/users' && method === 'POST') {
            if (h.users.has(body.id))
              return response({ code: 'user_already_exists', msg: 'exists' }, 422);
            const user = {
              id: body.id,
              aud: 'authenticated',
              email: body.email,
              created_at: new Date().toISOString(),
              user_metadata: body.user_metadata,
            };
            h.users.set(body.id, user);
            h.profiles.set(body.id, {
              id: body.id,
              is_horse: false,
              status: 'active',
              horse_status: 'available',
            });
            h.grants++;
            if (h.loseAck) throw TypeError('accepted original auth acknowledgement lost');
            return response(user);
          }
          if (url.pathname === '/rest/v1/profiles') {
            const id = url.searchParams.get('id')?.replace('eq.', '');
            if (method === 'PATCH') {
              if (h.profileError)
                return response({ code: 'P0001', message: 'profile completion failed' }, 400);
              const predicate = url.searchParams.get('or');
              expect(predicate).toBe(
                '(and(or(status.is.null,status.neq.deleted),or(horse_status.is.null,horse_status.neq.disabled),or(is_horse.is.null,is_horse.eq.false)))'
              );
              Object.assign(h.profiles.get(id!), body);
              return response([{ id }]);
            }
            return response(id && h.profiles.has(id) ? [h.profiles.get(id)] : []);
          }
          if (url.pathname === '/rest/v1/content_authors')
            return response([{ id: 'author', is_active: true }]);
          throw Error(`Unexpected external request ${method} ${url.pathname}`);
        },
      },
    }),
  };
});
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
import { createHorse } from './HorseOnboarding.js';
const operation = {
  horseId: '8b27a10f-e57b-47d9-9af0-132642e85c80',
  retiredHorseId: '00000000-0000-0000-0000-000000000002',
};
beforeEach(() => {
  h.users.clear();
  h.profiles.clear();
  h.requests = [];
  h.grants = 0;
  h.loseAck = false;
  h.profileError = false;
  h.lookupUnknown = false;
});
describe('actual Supabase Admin Auth and PostgREST client boundaries', () => {
  it('serializes the reserved id and original metadata, then recovers the accepted original after HTTP acknowledgement loss', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      h.loseAck = true;
      expect((await createHorse({ operation }))?.id).toBe(operation.horseId);
      expect(h.grants).toBe(1);
      const creates = h.requests.filter(
        (x) => x.path === '/auth/v1/admin/users' && x.method === 'POST'
      );
      expect(creates).toHaveLength(1);
      expect(creates[0].body.id).toBe(operation.horseId);
      expect(creates[0].body.user_metadata).toMatchObject({
        horse_creation_operation: 'patterned-retirement-20261006',
        retired_horse_id: operation.retiredHorseId,
      });
      expect(creates[0].body).not.toHaveProperty('password');
      expect(
        h.requests.filter((x) => x.path.endsWith('/' + operation.horseId) && x.method === 'GET')
      ).toHaveLength(2);
      expect(
        h.requests.every(
          (x) =>
            !x.path.includes('club_members') &&
            !x.path.includes('wallet') &&
            !x.path.includes('table_seats')
        )
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
  it('a failed PostgREST completion resumes the same accepted Auth account without another signup', async () => {
    h.profileError = true;
    expect(await createHorse({ operation })).toBeNull();
    expect(h.users.size).toBe(1);
    h.profileError = false;
    expect((await createHorse({ operation }))?.id).toBe(operation.horseId);
    expect(
      h.requests.filter((x) => x.path === '/auth/v1/admin/users' && x.method === 'POST')
    ).toHaveLength(1);
    expect(h.requests.filter((x) => x.method === 'DELETE')).toEqual([]);
    expect(h.grants).toBe(1);
  });
  it('unknown Auth lookup refuses rather than guessing absence and creating another account', async () => {
    h.lookupUnknown = true;
    expect(await createHorse({ operation })).toBeNull();
    expect(h.grants).toBe(0);
    expect(h.requests.filter((x) => x.method === 'POST')).toEqual([]);
  });
});
