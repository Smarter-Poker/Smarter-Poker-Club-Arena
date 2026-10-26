import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => {
  const state = {
    auth: new Map<string, any>(),
    profiles: new Map<string, any>(),
    grants: 0,
    createCalls: [] as any[],
    deletes: [] as string[],
    updates: [] as any[],
    unknownAfterCommit: false,
    unknownBeforeCommit: false,
    lookupUnknown: false,
    profileFailure: false,
    nullSignup: false,
    authorInactive: false,
    authorFailure: false,
    concurrentCompletion: false,
  };
  const db: any = {
    auth: {
      admin: {
        getUserById: vi.fn(async (id: string) =>
          state.lookupUnknown
            ? { data: { user: null }, error: { status: 503, message: 'unknown' } }
            : state.auth.has(id)
              ? { data: { user: state.auth.get(id) }, error: null }
              : {
                  data: { user: null },
                  error: { status: 404, code: 'user_not_found', message: 'absent' },
                }
        ),
        createUser: vi.fn(async (attrs: any) => {
          state.createCalls.push(attrs);
          if (state.unknownBeforeCommit) throw Error('transport before commit');
          if (state.auth.has(attrs.id))
            return { data: { user: null }, error: { message: 'already exists' } };
          const user = { id: attrs.id, user_metadata: attrs.user_metadata };
          state.auth.set(attrs.id, user);
          state.grants++;
          state.profiles.set(attrs.id, {
            id: attrs.id,
            is_horse: false,
            status: state.nullSignup ? null : 'active',
            horse_status: state.nullSignup ? null : 'available',
          });
          if (state.unknownAfterCommit) throw Error('acknowledgement lost after commit');
          return { data: { user }, error: null };
        }),
        deleteUser: vi.fn(async (id: string) => {
          state.deletes.push(id);
          return { error: null };
        }),
      },
    },
    from: (table: string) => {
      let id = '',
        update: any,
        predicate = '',
        nameQuery = false;
      const b: any = {
        select: () => b,
        eq: (key: string, value: string) => {
          if (key === 'id') id = value;
          return b;
        },
        neq: () => b,
        ilike: () => {
          nameQuery = true;
          return b;
        },
        limit: () => b,
        or: (value: string) => {
          predicate = value;
          return b;
        },
        update: (patch: any) => {
          update = patch;
          return b;
        },
        maybeSingle: async () =>
          table === 'content_authors'
            ? { data: { id: 'author', is_active: !state.authorInactive }, error: null }
            : { data: state.profiles.get(id) ?? null, error: null },
        then: (resolve: any, reject: any) => {
          if (update) {
            if (table === 'content_authors') {
              if (state.authorFailure)
                return Promise.resolve({ data: null, error: { message: 'author failed' } }).then(
                  resolve,
                  reject
                );
              state.authorInactive = false;
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            }
            if (state.profileFailure)
              return Promise.resolve({ data: null, error: { message: 'profile failed' } }).then(
                resolve,
                reject
              );
            const row = state.profiles.get(id);
            if (state.concurrentCompletion && update.is_horse === true) {
              state.concurrentCompletion = false;
              Object.assign(row, {
                is_horse: true,
                horse_profile: { aggression: 0.93, learned: 'newer' },
                display_name: 'Already Complete',
                alias: 'kept',
                is_vip: true,
                vip_tier: 'lifetime',
              });
            }
            if (
              predicate.includes('is_horse.eq.false') &&
              (row.is_horse === true || row.status === 'deleted' || row.horse_status === 'disabled')
            )
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            state.updates.push({ id, patch: update, predicate });
            Object.assign(row, update);
            return Promise.resolve({ data: [{ id }], error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: nameQuery ? [] : null, error: null }).then(
            resolve,
            reject
          );
        },
      };
      return b;
    },
  };
  return { state, db };
});
vi.mock('./supabase.js', () => ({ supabase: h.db }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
import { createHorse } from './HorseOnboarding.js';
const operation = {
  horseId: '8b27a10f-e57b-47d9-9af0-132642e85c80',
  retiredHorseId: '00000000-0000-0000-0000-000000000002',
};
beforeEach(() => {
  vi.clearAllMocks();
  h.state.auth.clear();
  h.state.profiles.clear();
  h.state.grants = 0;
  h.state.createCalls = [];
  h.state.deletes = [];
  h.state.updates = [];
  h.state.unknownAfterCommit = false;
  h.state.unknownBeforeCommit = false;
  h.state.lookupUnknown = false;
  h.state.profileFailure = false;
  h.state.nullSignup = false;
  h.state.authorInactive = false;
  h.state.authorFailure = false;
  h.state.concurrentCompletion = false;
});
describe('the replacement is the same original auth operation after interruption', () => {
  it('recovers an accepted auth create after its acknowledgement was lost, with one signup grant', async () => {
    h.state.unknownAfterCommit = true;
    expect((await createHorse({ operation }))?.id).toBe(operation.horseId);
    expect(h.state.grants).toBe(1);
    expect(h.state.createCalls).toHaveLength(1);
    expect(h.state.deletes).toEqual([]);
    expect(h.state.auth.get(operation.horseId).user_metadata.retired_horse_id).toBe(
      operation.retiredHorseId
    );
  });
  it('keeps an accepted account when profile completion fails, then resumes it without another signup', async () => {
    h.state.profileFailure = true;
    expect(await createHorse({ operation })).toBeNull();
    expect(h.state.deletes).toEqual([]);
    expect(h.state.auth.has(operation.horseId)).toBe(true);
    h.state.profileFailure = false;
    expect((await createHorse({ operation }))?.id).toBe(operation.horseId);
    expect(h.state.grants).toBe(1);
    expect(h.state.createCalls).toHaveLength(1);
  });
  it('reuses the reserved id after a definite missing original and a failed pre-commit request', async () => {
    h.state.unknownBeforeCommit = true;
    expect(await createHorse({ operation })).toBeNull();
    expect(h.state.grants).toBe(0);
    h.state.unknownBeforeCommit = false;
    expect((await createHorse({ operation }))?.id).toBe(operation.horseId);
    expect(h.state.createCalls.map((x) => x.id)).toEqual([operation.horseId, operation.horseId]);
    expect(h.state.grants).toBe(1);
  });
  it('preserves the completed horse brain and social identity on replay', async () => {
    await createHorse({ operation });
    const row = h.state.profiles.get(operation.horseId);
    row.horse_profile = { aggression: 0.91, learned: 'retained' };
    row.alias = 'kept';
    row.display_name = 'Already Complete';
    row.is_vip = true;
    row.vip_tier = 'lifetime';
    h.state.updates = [];
    expect((await createHorse({ operation }))?.id).toBe(operation.horseId);
    expect(row.horse_profile).toEqual({ aggression: 0.91, learned: 'retained' });
    expect(h.state.updates).toEqual([]);
    expect(h.state.grants).toBe(1);
  });
  it('two concurrent invocations cannot create two auth identities or signup grants', async () => {
    const results = await Promise.all([createHorse({ operation }), createHorse({ operation })]);
    expect(results.every((x) => x?.id === operation.horseId)).toBe(true);
    expect(h.state.auth.size).toBe(1);
    expect(h.state.grants).toBe(1);
    expect(h.state.deletes).toEqual([]);
  });
  it('an unknown lookup refuses before auth creation', async () => {
    h.state.lookupUnknown = true;
    expect(await createHorse({ operation })).toBeNull();
    expect(h.state.createCalls).toEqual([]);
    expect(h.state.deletes).toEqual([]);
  });
  it('never adopts or deletes an existing account owned by another operation', async () => {
    h.state.auth.set(operation.horseId, { id: operation.horseId, user_metadata: {} });
    expect(await createHorse({ operation })).toBeNull();
    expect(h.state.updates).toEqual([]);
    expect(h.state.createCalls).toEqual([]);
    expect(h.state.deletes).toEqual([]);
  });
  it('a resumed closed or disabled replacement stays closed', async () => {
    await createHorse({ operation });
    const row = h.state.profiles.get(operation.horseId);
    row.status = 'deleted';
    row.horse_status = 'disabled';
    h.state.updates = [];
    expect(await createHorse({ operation })).toBeNull();
    expect(h.state.updates).toEqual([]);
    expect(h.state.deletes).toEqual([]);
  });
});

describe('nullable and concurrently completed original signup profiles', () => {
  it('null status and horse status remain eligible and complete through null-inclusive CAS', async () => {
    h.state.nullSignup = true;
    expect((await createHorse({ operation }))?.id).toBe(operation.horseId);
    expect(h.state.profiles.get(operation.horseId).is_horse).toBe(true);
    expect(h.state.profiles.get(operation.horseId).status).toBeNull();
    expect(h.state.updates[0].predicate).toContain('or(status.is.null,status.neq.deleted)');
    expect(h.state.updates[0].predicate).toContain(
      'or(horse_status.is.null,horse_status.neq.disabled)'
    );
  });
  it('a concurrent completion wins CAS and its learned brain is retained', async () => {
    h.state.concurrentCompletion = true;
    expect((await createHorse({ operation }))?.id).toBe(operation.horseId);
    expect(h.state.profiles.get(operation.horseId).horse_profile).toEqual({
      aggression: 0.93,
      learned: 'newer',
    });
    expect(h.state.updates).toEqual([]);
    expect(h.state.grants).toBe(1);
    expect(h.state.deletes).toEqual([]);
  });
});

describe('social completion is an actual result, not fake success', () => {
  it('preserves the accepted original account on a social error and resumes social completion', async () => {
    h.state.authorInactive = true;
    h.state.authorFailure = true;
    expect(await createHorse({ operation })).toBeNull();
    expect(h.state.auth.has(operation.horseId)).toBe(true);
    expect(h.state.deletes).toEqual([]);
    h.state.authorFailure = false;
    expect((await createHorse({ operation }))?.id).toBe(operation.horseId);
    expect(h.state.authorInactive).toBe(false);
    expect(h.state.grants).toBe(1);
  });
});
