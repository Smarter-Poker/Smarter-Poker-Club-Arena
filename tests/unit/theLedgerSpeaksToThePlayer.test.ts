/**
 * Phase 6: the ledger row carries the line the player reads (`player_line`),
 * and the surfaces print that line, never the raw description.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const chain = vi.hoisted(() => ({ rows: [] as unknown[], selected: '' }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const q: Record<string, unknown> = {};
      const self = () => q;
      q.select = (cols: string) => {
        chain.selected = cols;
        return q;
      };
      q.eq = self;
      q.gt = self;
      q.or = self;
      q.order = self;
      q.range = async () => ({ data: chain.rows, error: null });
      return q;
    },
    rpc: vi.fn(),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const { useDiamondLedger } = await import('../../src/hooks/useDiamondLedger');

describe('useDiamondLedger carries the player line', () => {
  beforeEach(() => {
    chain.rows = [];
    chain.selected = '';
  });

  it('selects player_line with the row and surfaces it as `line`', async () => {
    chain.rows = [
      {
        id: 'r1',
        type: 'pvp_refund',
        transaction_type: 'pvp_refund',
        amount: 10,
        description: 'PvP match abandoned — 10diamonds refund',
        player_line: 'PvP match abandoned, 10 diamonds refund',
        created_at: '2026-08-23T00:00:00Z',
        metadata: null,
      },
      {
        id: 'r2',
        type: 'daily_challenge_claim',
        transaction_type: 'daily_challenge_claim',
        amount: 25,
        description: 'Challenge reward: sd_10',
        player_line: 'Daily Challenge Reward',
        created_at: '2026-09-19T00:00:00Z',
        metadata: {},
      },
    ];
    const isMounted = { current: true };
    const { result } = renderHook(() => useDiamondLedger('u-1', 'in', isMounted));
    await act(() => result.current.load('reset'));
    await waitFor(() => expect(result.current.rows).not.toBeNull());
    expect(chain.selected).toBe(
      'id, type, transaction_type, amount, description, player_line, created_at, metadata'
    );
    const rows = result.current.rows!;
    expect(rows.map((r) => r.line)).toEqual([
      'PvP match abandoned, 10 diamonds refund',
      'Daily Challenge Reward',
    ]);
    // The raw description is still carried, but it is not what a surface prints.
    expect(rows[0].description).toContain('—');
    expect(rows[0].line).not.toContain('—');
  });

  it('a row that came back without player_line has an empty line, and the surface falls back to the label', async () => {
    chain.rows = [
      {
        id: 'r3',
        type: 'signup_bonus',
        transaction_type: null,
        amount: 500,
        description: 'Welcome bonus — 300 free diamonds',
        created_at: '2026-02-12T00:00:00Z',
        metadata: null,
      },
    ];
    const isMounted = { current: true };
    const { result } = renderHook(() => useDiamondLedger('u-1', 'in', isMounted));
    await act(() => result.current.load('reset'));
    await waitFor(() => expect(result.current.rows).not.toBeNull());
    expect(result.current.rows![0].line).toBe('');
    expect(result.current.rows![0].label.length).toBeGreaterThan(0);
  });
});
