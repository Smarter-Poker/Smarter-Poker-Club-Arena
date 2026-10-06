/**
 * A CLOSED HORSE STAYS CLOSED, THE WHOLE FLEET IS SWEPT, AND A NEW HORSE IS
 * AN ACCOUNT FIRST (2026-10-06).
 *
 * 1. sweepIncompleteHorses read one unordered page of 1,000 rows, so with
 *    1,062 horse profiles an arbitrary tail was never completed. It now walks
 *    every horse in id order.
 * 2. It also completed every is_horse row, including a CLOSED one
 *    (status 'deleted'), refilling its name and alias and re-activating its
 *    muted content_authors row. The retirement of the 62 horses whose
 *    hand-made ids labelled them depends on a closed identity staying closed.
 *    A benched horse (horse_status 'disabled') is left alone as well.
 * 3. createHorse inserted a profiles row with no auth.users row behind it,
 *    which profiles_id_fkey refuses, so it could never create a horse. It now
 *    has the auth service mint the account (random v4 id, no password, a
 *    mailbox that receives nothing) and then makes that profile the horse.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Filter = [string, ...unknown[]];
interface Call {
  table: string;
  op: 'select' | 'update' | 'insert';
  filters: Filter[];
  payload?: unknown;
  selectedAfterWrite?: boolean;
}

const h = vi.hoisted(() => {
  const state = {
    profiles: [] as Array<Record<string, unknown>>,
    calls: [] as Call[],
    authCreates: [] as Array<Record<string, unknown>>,
    authDeletes: [] as string[],
    profileUpdateError: null as null | { message: string },
    nameClash: false,
  };

  function builder(table: string) {
    const call: Call = { table, op: 'select', filters: [] };
    state.calls.push(call);
    const has = (op: string, col?: string) =>
      call.filters.find((f) => f[0] === op && (col === undefined || f[1] === col));

    function execute(): { data: unknown; error: unknown } {
      if (call.op === 'update') {
        if (table === 'profiles' && call.selectedAfterWrite) {
          if (state.profileUpdateError) return { data: null, error: state.profileUpdateError };
          const id = has('eq', 'id')?.[2];
          return { data: [{ id }], error: null };
        }
        return { data: null, error: null };
      }
      if (table === 'profiles' && has('ilike')) {
        const col = has('ilike')?.[1];
        return {
          data: col === 'display_name' && state.nameClash ? [{ id: 'person' }] : [],
          error: null,
        };
      }
      if (table === 'profiles' && has('eq', 'is_horse') && has('order', 'id')) {
        const after = has('gt', 'id')?.[2] as string | undefined;
        const limit = (has('limit')?.[1] as number) ?? Infinity;
        const rows = state.profiles
          .filter((r) => r.is_horse === true)
          .filter((r) => after === undefined || (r.id as string) > after)
          .sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1))
          .slice(0, limit);
        return { data: rows, error: null };
      }
      return { data: [], error: null };
    }

    const b: Record<string, unknown> = {
      select: () => {
        if (call.op !== 'select') call.selectedAfterWrite = true;
        return b;
      },
      update: (v: unknown) => {
        call.op = 'update';
        call.payload = v;
        return b;
      },
      insert: (v: unknown) => {
        call.op = 'insert';
        call.payload = v;
        return Promise.resolve({ error: null });
      },
      eq: (c: string, v: unknown) => (call.filters.push(['eq', c, v]), b),
      neq: (c: string, v: unknown) => (call.filters.push(['neq', c, v]), b),
      gt: (c: string, v: unknown) => (call.filters.push(['gt', c, v]), b),
      ilike: (c: string, v: unknown) => (call.filters.push(['ilike', c, v]), b),
      or: (v: string) => (call.filters.push(['or', v]), b),
      order: (c: string) => (call.filters.push(['order', c]), b),
      limit: (n: number) => (call.filters.push(['limit', n]), b),
      maybeSingle: () => {
        // content_authors: every horse has a muted author row, so completing a
        // horse would re-activate it - which is exactly what must never reach
        // a closed one. Its id is the profile id so the write can be traced.
        if (table === 'content_authors') {
          const pid = has('eq', 'profile_id')?.[2];
          return Promise.resolve({
            data: { id: pid, profile_id: pid, avatar_url: null, is_active: false },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(execute()).then(res, rej),
    };
    return b;
  }

  const supabase = {
    from: (t: string) => builder(t),
    auth: {
      admin: {
        createUser: vi.fn(async (attrs: Record<string, unknown>) => {
          state.authCreates.push(attrs);
          return { data: { user: { id: attrs.id } }, error: null };
        }),
        deleteUser: vi.fn(async (id: string) => {
          state.authDeletes.push(id);
          return { data: {}, error: null };
        }),
      },
    },
  };
  return { state, supabase };
});

vi.mock('./supabase.js', () => ({ supabase: h.supabase }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

import {
  createHorse,
  ensureHorseComplete,
  isSweepEligible,
  sweepIncompleteHorses,
  HORSE_AUTH_EMAIL_DOMAIN,
} from './HorseOnboarding.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fleet() {
  // 1,062 horse profiles, the 2026-10-06 count; 62 of them closed and
  // benched (the retired cohort), 5 more only benched.
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 1062; i++) {
    const id = `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
    const closed = i % 17 === 3 && rows.filter((r) => r.status === 'deleted').length < 62;
    rows.push({
      id,
      is_horse: true,
      display_name: closed ? null : `Name ${i}`,
      username: closed ? `deleted-${i}` : `user${i}`,
      alias: closed ? null : `al${i}`,
      player_number: 100000 + i,
      avatar_url: null,
      is_vip: true,
      vip_tier: 'lifetime',
      horse_profile: { style: 'tag', aggression: 1 },
      status: closed ? 'deleted' : 'active',
      horse_status:
        closed || i === 5 || i === 6 || i === 7 || i === 8 || i === 9 ? 'disabled' : 'available',
    });
  }
  rows.push({ id: 'ffffffff-0000-4000-8000-000000000000', is_horse: false, status: 'active' });
  return rows;
}

beforeEach(() => {
  h.state.profiles = fleet();
  h.state.calls = [];
  h.state.authCreates = [];
  h.state.authDeletes = [];
  h.state.profileUpdateError = null;
  h.state.nameClash = false;
  h.supabase.auth.admin.createUser.mockClear();
  h.supabase.auth.admin.deleteUser.mockClear();
});

const writesTouching = (ids: Set<string>) =>
  h.state.calls.filter(
    (c) =>
      c.op !== 'select' &&
      (ids.has(String(c.filters.find((f) => f[0] === 'eq' && f[1] === 'id')?.[2])) ||
        ids.has(String((c.payload as Record<string, unknown> | undefined)?.profile_id)))
  );

describe('who the sweep may touch', () => {
  it('a closed account and a benched horse are not eligible; a playing horse is', () => {
    expect(isSweepEligible({ status: 'deleted', horse_status: 'available' })).toBe(false);
    expect(isSweepEligible({ status: 'active', horse_status: 'disabled' })).toBe(false);
    expect(isSweepEligible({ status: ' Deleted ', horse_status: null })).toBe(false);
    expect(isSweepEligible({ status: 'active', horse_status: 'available' })).toBe(true);
    expect(isSweepEligible({ status: null, horse_status: null })).toBe(true);
  });

  it('ensureHorseComplete does nothing at all to a closed account', async () => {
    const closed = h.state.profiles.find((r) => r.status === 'deleted')!;
    const fixed = await ensureHorseComplete(closed as never);
    expect(fixed).toEqual([]);
    expect(h.state.calls).toHaveLength(0);
  });
});

describe('the boot sweep', () => {
  it('walks every one of 1,062 horses in id order, a page at a time', async () => {
    const r = await sweepIncompleteHorses(500);
    const reads = h.state.calls.filter(
      (c) => c.table === 'profiles' && c.op === 'select' && c.filters.some((f) => f[0] === 'order')
    );
    expect(reads).toHaveLength(3);
    expect(reads[0].filters.find((f) => f[0] === 'gt')).toBeUndefined();
    expect(reads[1].filters.find((f) => f[0] === 'gt')?.[2]).toBe(h.state.profiles[499].id);
    expect(r.checked + r.skipped).toBe(1062);
    expect(r.skipped).toBe(67);
    expect(r.checked).toBe(995);
  });

  it('never writes to a closed or benched horse, and still completes the rest', async () => {
    await sweepIncompleteHorses(500);
    const ineligible = new Set(
      h.state.profiles
        .filter((p) => p.is_horse && !isSweepEligible(p as never))
        .map((p) => String(p.id))
    );
    expect(ineligible.size).toBe(67);
    expect(writesTouching(ineligible)).toEqual([]);
    // every eligible horse's muted voice is restored - the sweep still works
    const reactivated = h.state.calls.filter(
      (c) =>
        c.table === 'content_authors' &&
        c.op === 'update' &&
        (c.payload as { is_active?: boolean }).is_active === true
    );
    expect(reactivated).toHaveLength(995);
  });

  it('a profile repair cannot reopen an account closed between the read and the write', async () => {
    h.state.profiles = fleet().map((p) =>
      p.is_horse && p.status === 'active' ? { ...p, alias: null } : p
    );
    await sweepIncompleteHorses(500);
    const repairs = h.state.calls.filter((c) => c.table === 'profiles' && c.op === 'update');
    expect(repairs.length).toBe(995);
    for (const c of repairs)
      expect(c.filters).toContainEqual(['or', 'status.is.null,status.neq.deleted']);
  });
});

describe('createHorse', () => {
  it('has the auth service mint the account first, with a random v4 id and no usable login', async () => {
    const made = await createHorse();
    expect(made).not.toBeNull();
    expect(h.supabase.auth.admin.createUser).toHaveBeenCalledTimes(1);
    const attrs = h.state.authCreates[0];
    expect(attrs.id).toBe(made!.id);
    expect(String(attrs.id)).toMatch(UUID_V4);
    expect(String(attrs.id)).not.toMatch(/^(00000000|face0000)-/);
    expect(attrs).not.toHaveProperty('password');
    expect(String(attrs.email).endsWith(`@${HORSE_AUTH_EMAIL_DOMAIN}`)).toBe(true);
    expect(attrs.email_confirm).toBe(true);

    // the profile is the one the signup trigger created, made into the horse -
    // never inserted beside the auth row
    expect(h.state.calls.filter((c) => c.table === 'profiles' && c.op === 'insert')).toEqual([]);
    const update = h.state.calls.find(
      (c) => c.table === 'profiles' && c.op === 'update' && c.selectedAfterWrite
    )!;
    expect(update.filters).toContainEqual(['eq', 'id', made!.id]);
    expect(update.payload).toMatchObject({
      is_horse: true,
      horse_status: 'available',
      vip_tier: 'lifetime',
    });
    // and no club membership conjured with chips and no ledger row
    expect(h.state.calls.filter((c) => c.table === 'club_members')).toEqual([]);
  });

  it('two horses never share an id', async () => {
    const a = await createHorse();
    const b = await createHorse();
    expect(a!.id).not.toBe(b!.id);
  });

  it('refuses a name a person answers to before any account exists', async () => {
    h.state.nameClash = true;
    expect(await createHorse({ realName: 'Pat Example' })).toBeNull();
    expect(h.supabase.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it('takes the account back out if it never became a horse', async () => {
    h.state.profileUpdateError = { message: 'boom' };
    expect(await createHorse()).toBeNull();
    expect(h.state.authDeletes).toEqual([h.state.authCreates[0].id]);
  });
});
