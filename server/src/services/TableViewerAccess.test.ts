import { beforeEach, describe, expect, it, vi } from 'vitest';

const queriedTables = vi.hoisted(() => vi.fn());

const results = vi.hoisted(() => ({
  tables: {
    data: {
      club_id: 'club-1',
      restrict_observers: false,
      arena: { id: 'club-1', asset: 'chips', is_platform: false, union_id: null },
    } as Record<string, unknown> | null,
    error: null as unknown,
  },
  table_seats: { data: null as Record<string, unknown> | null, error: null as unknown },
  club_members: {
    data: { user_id: 'member-1' } as Record<string, unknown> | null,
    error: null as unknown,
  },
}));

vi.mock('./supabase.js', () => ({
  supabase: {
    from: (table: keyof typeof results) => {
      queriedTables(table);
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'is', 'in', 'limit']) {
        builder[method] = vi.fn(() => builder);
      }
      builder.maybeSingle = vi.fn(async () => results[table]);
      return builder;
    },
  },
}));

import { authorizeTableViewer } from './TableViewerAccess.js';

describe('authorizeTableViewer', () => {
  beforeEach(() => {
    queriedTables.mockClear();
    results.tables = {
      data: {
        club_id: 'club-1',
        restrict_observers: false,
        arena: { id: 'club-1', asset: 'chips', is_platform: false, union_id: null },
      },
      error: null,
    };
    results.table_seats = { data: null, error: null };
    results.club_members = { data: { user_id: 'member-1' }, error: null };
  });

  it('allows an active club member to observe', async () => {
    await expect(authorizeTableViewer('table-1', 'user-1')).resolves.toEqual({
      allowed: true,
      reason: 'club_member',
      clubId: 'club-1',
    });
  });

  it('allows a currently seated player even if membership changed', async () => {
    results.table_seats.data = { id: 'seat-1' };
    results.club_members.data = null;
    await expect(authorizeTableViewer('table-1', 'user-1')).resolves.toMatchObject({
      allowed: true,
      reason: 'seated',
    });
  });

  it('denies a non-seated member when the table restricts observers', async () => {
    results.tables.data = {
      club_id: 'club-1',
      restrict_observers: true,
      arena: { id: 'club-1', asset: 'chips', is_platform: false, union_id: null },
    };

    await expect(authorizeTableViewer('table-1', 'user-1')).resolves.toEqual({
      allowed: false,
      reason: 'observers_restricted',
      clubId: 'club-1',
    });
  });

  it('allows a seated player when the table restricts observers', async () => {
    results.tables.data = {
      club_id: 'club-1',
      restrict_observers: true,
      arena: { id: 'club-1', asset: 'chips', is_platform: false, union_id: null },
    };
    results.table_seats.data = { id: 'seat-1' };

    await expect(authorizeTableViewer('table-1', 'user-1')).resolves.toMatchObject({
      allowed: true,
      reason: 'seated',
    });
  });

  it('denies a non-member and fails closed on lookup errors', async () => {
    results.club_members.data = null;
    await expect(authorizeTableViewer('table-1', 'outsider')).resolves.toMatchObject({
      allowed: false,
      reason: 'membership_required',
    });

    results.club_members.error = new Error('database unavailable');
    await expect(authorizeTableViewer('table-1', 'outsider')).resolves.toMatchObject({
      allowed: false,
      reason: 'check_failed',
    });
  });
});

describe('seated reconnect access dependencies', () => {
  beforeEach(() => {
    queriedTables.mockClear();
    results.tables = {
      data: {
        club_id: 'club-1',
        restrict_observers: true,
        arena: { id: 'club-1', asset: 'chips', is_platform: false, union_id: null },
      },
      error: null,
    };
    results.table_seats = { data: { id: 'seat-1' }, error: null };
    results.club_members = { data: null, error: new Error('membership lookup unavailable') };
  });

  it('accepts a verified seat without depending on membership availability', async () => {
    await expect(authorizeTableViewer('table-1', 'user-1')).resolves.toMatchObject({
      allowed: true,
      reason: 'seated',
      clubId: 'club-1',
    });
    expect(queriedTables.mock.calls.flat()).not.toContain('club_members');
  });

  it('still fails closed when the seat lookup itself fails', async () => {
    results.table_seats.error = new Error('seat check unavailable');
    await expect(authorizeTableViewer('table-1', 'user-1')).resolves.toMatchObject({
      allowed: false,
      reason: 'check_failed',
    });
  });

  it('does not let a seat bypass a missing table', async () => {
    results.tables.data = null;
    await expect(authorizeTableViewer('table-1', 'user-1')).resolves.toMatchObject({
      allowed: false,
      reason: 'table_not_found',
    });
  });
});

describe('Diamond Arena entitlement', () => {
  beforeEach(() => {
    queriedTables.mockClear();
    results.tables = {
      data: {
        club_id: 'diamond',
        restrict_observers: false,
        arena: { id: 'diamond', asset: 'diamonds', is_platform: true, union_id: null },
      },
      error: null,
    };
    results.table_seats = { data: null, error: null };
    results.club_members = { data: null, error: new Error('No private membership') };
  });
  it('allows a signed-in player without a membership row or hierarchy query', async () => {
    expect(await authorizeTableViewer('table-1', 'player')).toEqual({
      allowed: true,
      reason: 'diamond_member',
      clubId: 'diamond',
    });
    expect(queriedTables.mock.calls.flat()).not.toContain('club_members');
  });
  it('still enforces observer restrictions', async () => {
    results.tables.data!.restrict_observers = true;
    expect((await authorizeTableViewer('table-1', 'player')).reason).toBe('observers_restricted');
  });
  it.each([
    { id: 'diamond', asset: 'unknown', is_platform: true, union_id: null },
    { id: 'diamond', asset: 'diamonds', is_platform: false, union_id: null },
    { id: 'diamond', asset: 'diamonds', is_platform: true, union_id: 'union' },
    { id: 'other', asset: 'diamonds', is_platform: true, union_id: null },
    null,
  ])('rejects invalid or forged arena configuration even with a seat', async (arena) => {
    results.tables.data!.arena = arena;
    results.table_seats.data = { id: 'seat' };
    expect((await authorizeTableViewer('table-1', 'player')).allowed).toBe(false);
  });
  it('does not authorize an empty identity', async () => {
    expect((await authorizeTableViewer('table-1', '')).allowed).toBe(false);
  });
});
