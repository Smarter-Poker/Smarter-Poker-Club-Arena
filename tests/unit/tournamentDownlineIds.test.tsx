import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), page: vi.fn(), report: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: api }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: api.report }));
import { useDownlineIds } from '../../src/components/tournament/details/useDownlineIds';

function membership(role = 'super_agent') {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi
      .fn()
      .mockImplementation((_column, clubs) =>
        Promise.resolve({ data: clubs.map((club_id: string) => ({ club_id, role })), error: null })
      ),
  };
  api.from.mockReturnValue(query);
}

beforeEach(() => {
  vi.resetAllMocks();
  membership();
  api.rpc.mockImplementation((name, parameters) =>
    name === 'fn_club_scope_ids'
      ? Promise.resolve({ data: [parameters.p_club_id], error: null })
      : {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          range: api.page,
        }
  );
  api.page.mockResolvedValue({ data: [], error: null });
});
afterEach(cleanup);

describe('tournament Mine Only uses the authorized complete roster downline', () => {
  it('includes nested players and playing agents from the roster, excluding the viewer', async () => {
    api.page.mockResolvedValue({
      data: ['direct', 'nested-player', 'nested-agent', 'viewer'].map((user_id) => ({ user_id })),
      error: null,
    });
    const { result } = renderHook(() => useDownlineIds('viewer', 'club'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect([...result.current.downlineIds]).toEqual(['direct', 'nested-player', 'nested-agent']);
    expect(result.current.carriesDownline).toBe(true);
    expect(api.rpc).toHaveBeenCalledWith('ca_club_member_downline', {
      p_club_id: 'club',
      p_user_id: 'viewer',
    });
    expect(api.from.mock.calls).toEqual([['club_members']]);
    expect(api.rpc.mock.results[1].value.select).toHaveBeenCalledWith('user_id');
    expect(api.rpc.mock.results[1].value.order).toHaveBeenCalledWith('user_id', {
      ascending: true,
    });
  });

  it.each(['owner', 'co_owner', 'admin'])(
    'includes the whole authorized club for %s, beyond directly assigned players',
    async (role) => {
      membership(role);
      api.page.mockResolvedValue({
        data: ['direct-player', 'other-agent', 'other-agent-player', 'viewer'].map((user_id) => ({
          user_id,
        })),
        error: null,
      });
      const { result } = renderHook(() => useDownlineIds('viewer', 'club'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect([...result.current.downlineIds]).toEqual([
        'direct-player',
        'other-agent',
        'other-agent-player',
      ]);
      expect(api.rpc).toHaveBeenCalledWith('ca_club_members_overview', { p_club_id: 'club' });
    }
  );

  it('resolves linked union clubs, applies each club role, and deduplicates shared members', async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [
          { club_id: 'anchor', role: 'owner' },
          { club_id: 'nested', role: 'agent' },
          { club_id: 'unrelated', role: 'player' },
        ],
        error: null,
      }),
    };
    api.from.mockReturnValue(query);
    api.rpc.mockImplementation((name, parameters) => {
      if (name === 'fn_club_scope_ids')
        return Promise.resolve({ data: ['anchor', 'nested', 'unrelated'], error: null });
      const page =
        parameters.p_club_id === 'anchor' ? ['direct', 'shared'] : ['nested-player', 'shared'];
      return {
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: vi
          .fn()
          .mockResolvedValue({ data: page.map((user_id) => ({ user_id })), error: null }),
      };
    });
    const { result } = renderHook(() => useDownlineIds('viewer', 'anchor', 'union'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect([...result.current.downlineIds]).toEqual(['direct', 'shared', 'nested-player']);
    expect(api.rpc.mock.calls).toEqual([
      ['fn_club_scope_ids', { p_club_id: 'union' }],
      ['ca_club_members_overview', { p_club_id: 'anchor' }],
      ['ca_club_member_downline', { p_club_id: 'nested', p_user_id: 'viewer' }],
    ]);
  });

  it('exhausts pages instead of dropping players beyond the API row cap', async () => {
    api.page
      .mockResolvedValueOnce({
        data: Array.from({ length: 500 }, (_, i) => ({ user_id: `p${i}` })),
        error: null,
      })
      .mockResolvedValueOnce({ data: [{ user_id: 'last-descendant' }], error: null });
    const { result } = renderHook(() => useDownlineIds('viewer', 'club'));
    await waitFor(() => expect(result.current.downlineIds.size).toBe(501));
    expect(api.page.mock.calls).toEqual([
      [0, 499],
      [500, 999],
    ]);
    expect(result.current.downlineIds.has('last-descendant')).toBe(true);
  });

  it('retains the plain-player role gate', async () => {
    membership('player');
    const { result } = renderHook(() => useDownlineIds('viewer', 'club'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.carriesDownline).toBe(false);
    expect(api.rpc.mock.calls.map(([name]) => name)).toEqual(['fn_club_scope_ids']);
  });

  it('does not publish a partial downline when a later page fails', async () => {
    api.page
      .mockResolvedValueOnce({
        data: Array.from({ length: 500 }, (_, i) => ({ user_id: `p${i}` })),
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: new Error('refused') });
    const { result } = renderHook(() => useDownlineIds('viewer', 'club'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.downlineIds.size).toBe(0);
    expect(result.current.carriesDownline).toBe(false);
    expect(api.report).toHaveBeenCalled();
  });

  it('refuses malformed or repeating pages instead of claiming a complete result', async () => {
    api.page.mockResolvedValue({
      data: [{ user_id: 'duplicate' }, { user_id: 'duplicate' }],
      error: null,
    });
    const { result } = renderHook(() => useDownlineIds('viewer', 'club'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.downlineIds.size).toBe(0);
    expect(result.current.carriesDownline).toBe(false);
  });

  it('clears the previous club and ignores its late response after switching', async () => {
    let resolveOld!: (value: unknown) => void;
    api.page
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValue({ data: [{ user_id: 'new-player' }], error: null });
    const { result, rerender } = renderHook(({ club }) => useDownlineIds('viewer', club), {
      initialProps: { club: 'old' },
    });
    await waitFor(() => expect(api.page).toHaveBeenCalledTimes(1));
    rerender({ club: 'new' });
    await waitFor(() => expect(result.current.downlineIds.has('new-player')).toBe(true));
    await act(async () => resolveOld({ data: [{ user_id: 'old-player' }], error: null }));
    expect([...result.current.downlineIds]).toEqual(['new-player']);
  });
});
