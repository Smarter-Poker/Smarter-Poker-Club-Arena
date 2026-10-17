/**
 * EVERY MEMBER, NOT THE FIRST 1,000 (2026-10-17).
 *
 * PostgREST caps every response at max-rows (1,000), RPCs included, and says
 * nothing about it. Midway Union's Union Bank read "3 Clubs · 1,000 Members"
 * on production while its directory holds 1,744 rows. The modal now pages the
 * directory on a total order until a short page comes back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const UNION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOTAL = 1437;
const roster = Array.from({ length: TOTAL }, (_, i) => ({
  user_id: `u-${String(i).padStart(5, '0')}`,
  username: `player${i}`,
  display_name: null,
  avatar_url: null,
  club_id: i % 2 ? 'c-1' : 'c-2',
  club_name: i % 2 ? 'Club JAQK' : 'SHARK CLUB',
  member_role: 'member',
  member_status: 'active',
}));
const calls = vi.hoisted(() => ({ ranges: [] as Array<[number, number]>, orders: [] as string[] }));

vi.mock('../src/lib/supabase', () => {
  const fromChain = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'range', 'contains'])
      chain[m] = () => chain;
    chain.then = (ok: (v: unknown) => unknown) =>
      ok({
        data:
          table === 'union_clubs'
            ? [
                { club_id: 'c-1', clubs: { name: 'Club JAQK' } },
                { club_id: 'c-2', clubs: { name: 'SHARK CLUB' } },
              ]
            : [],
        error: null,
      });
    return chain;
  };
  return {
    supabase: {
      from: (t: string) => fromChain(t),
      rpc: (fn: string) => {
        let from = 0;
        let to = 0;
        const chain: Record<string, unknown> = {
          order: (col: string) => {
            if (fn === 'fn_union_player_directory') calls.orders.push(col);
            return chain;
          },
          limit: () => chain,
          range: (a: number, b: number) => {
            from = a;
            to = b;
            if (fn === 'fn_union_player_directory') calls.ranges.push([a, b]);
            return chain;
          },
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
            Promise.resolve(
              fn === 'fn_union_player_directory'
                ? // A server that holds max-rows: never more than 1,000 per answer.
                  { data: roster.slice(from, Math.min(to + 1, from + 1000)), error: null }
                : { data: null, error: null }
            ).then(ok, bad),
        };
        return chain;
      },
    },
  };
});
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({
    user: { id: '11111111-1111-4111-8111-111111111111' },
    isAuthenticated: true,
  }),
}));

import { UnionWalletModal } from '../src/components/union/UnionWalletModal';

beforeEach(() => {
  calls.ranges.length = 0;
  calls.orders.length = 0;
});

describe('the union directory reads every member', () => {
  it('pages past the 1,000-row cap on a total order until a short page', async () => {
    render(
      <UnionWalletModal
        isOpen
        onClose={() => {}}
        unionId={UNION_ID}
        walletKey="chips"
        walletLabel="Union Bank"
        balance={1000}
      />
    );
    // The heading counts every row read, past the cap.
    expect(await screen.findByText(/1,437 Members/)).toBeTruthy();
    expect(calls.ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(calls.orders.slice(0, 2)).toEqual(['club_id', 'user_id']);
  });
});
