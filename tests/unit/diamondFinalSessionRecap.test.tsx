import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  userId: '00000000-0000-4000-8000-000000000002',
  rpc: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: testState.rpc } }));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (select: (state: unknown) => unknown) =>
    select({
      user: { id: testState.userId },
      currentClubId: 'original-club',
    }),
}));
vi.mock('../../src/components/ads/HouseAdRotator', () => ({ default: () => null }));
import SessionSummaryHost from '../../src/components/session/SessionSummaryHost';
import {
  clearSessionSummary,
  publishSessionSummary,
  settlePendingSummary,
  peekSessionSummary,
  type SessionSummaryPayload,
} from '../../src/services/pendingSessionSummary';
import {
  parseDiamondCashSessionRecap,
  type DiamondRecapTarget,
} from '../../src/services/diamondCashSessionRecap';
import { mergeSessionFacts } from '../../src/utils/sessionBuyInTotal';

const target: DiamondRecapTarget = {
  userId: '00000000-0000-4000-8000-000000000002',
  tableId: '00000000-0000-4000-8000-000000000004',
  occupancyId: '00000000-0000-4000-8000-000000000006',
  notify: true,
};
const recorded = (over: Record<string, unknown> = {}) => ({
  asset: 'diamonds',
  status: 'settled',
  user_id: target.userId,
  table_id: target.tableId,
  occupancy_id: target.occupancyId,
  custody_id: '00000000-0000-4000-8000-000000000001',
  started_at: '2026-10-12T05:47:04.687Z',
  released_at: '2026-10-12T06:20:44.888Z',
  total_buy_in: 4000,
  chips_returned: 1376,
  jackpot_awards: 0,
  profit_loss: -2624,
  hands_played: 20,
  hands_won: 11,
  vpip_percent: 65,
  peak_stack: 4099,
  total_rebuys: 0,
  notification_id: '00000000-0000-4000-8000-000000000001',
  ...over,
});
// Actual reported reload values, deliberately wrong. The card must not print
// or share them, even while its authoritative read is delayed or unavailable.
const oldMount = (over: Partial<SessionSummaryPayload> = {}): SessionSummaryPayload => ({
  arenaAsset: 'diamonds',
  diamondRecap: target,
  tableName: 'NLH 10/20',
  profitLoss: 400,
  totalBuyIn: 976,
  handsPlayed: 5,
  handsWon: 5,
  duration: 180,
  peakStack: 976,
  biggestPot: 0,
  totalRebuys: 0,
  vpipPercent: 0,
  ...over,
});
const view = () => (
  <MemoryRouter>
    <SessionSummaryHost />
  </MemoryRouter>
);

beforeEach(() => {
  clearSessionSummary();
  testState.userId = target.userId;
  testState.rpc.mockReset();
  testState.rpc.mockResolvedValue({ data: recorded(), error: null });
  vi.stubGlobal('matchMedia', () => ({ matches: true, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  clearSessionSummary();
  vi.unstubAllGlobals();
});

describe('the final Diamond card belongs to its closed custody', () => {
  it('hides the wrong reload result, then displays the actual whole session', async () => {
    let answer!: (value: unknown) => void;
    testState.rpc.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    render(view());
    act(() => publishSessionSummary(oldMount()));
    expect(screen.getByText('Reading Recorded Session')).toBeTruthy();
    expect(screen.queryByText('Profit')).toBeNull();
    expect(screen.queryByText('976')).toBeNull();
    expect((screen.getByLabelText('Share This Session') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer({ data: recorded(), error: null }));
    expect(screen.getByText('-2,624.00 Diamonds')).toBeTruthy();
    expect(screen.getByText('4,000')).toBeTruthy();
    expect(screen.getByText('20')).toBeTruthy();
    expect(screen.getByText('33m')).toBeTruthy();
    expect(screen.getByText('65%')).toBeTruthy();
    expect(screen.getByText('55%')).toBeTruthy();
    expect(testState.rpc).toHaveBeenCalledTimes(1);
    expect(testState.rpc).toHaveBeenCalledWith('fn_notify_my_diamond_cash_session_recap', {
      p_table_id: target.tableId,
      p_occupancy_id: target.occupancyId,
    });
  });

  it('keeps errors truthful and retries only when explicitly requested', async () => {
    testState.rpc.mockResolvedValueOnce({ data: null, error: { message: 'unavailable' } });
    render(view());
    act(() => publishSessionSummary(oldMount()));
    await screen.findByText('Recorded Session Unavailable');
    expect(screen.queryByText('Profit')).toBeNull();
    expect(testState.rpc).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Retry Recorded Session'));
    await screen.findByText('-2,624.00 Diamonds');
    expect(testState.rpc).toHaveBeenCalledTimes(2);
  });

  it('cannot apply an old answer to a new card or a different account', async () => {
    let answer!: (value: unknown) => void;
    testState.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const rendered = render(view());
    act(() => publishSessionSummary(oldMount()));
    await waitFor(() => expect(testState.rpc).toHaveBeenCalledTimes(1));
    const next = { ...target, occupancyId: '00000000-0000-4000-8000-000000000007' };
    testState.rpc.mockResolvedValueOnce({
      data: recorded({ occupancy_id: next.occupancyId, profit_loss: -3000, chips_returned: 1000 }),
      error: null,
    });
    act(() => publishSessionSummary(oldMount({ diamondRecap: next })));
    await screen.findByText('-3,000.00 Diamonds');
    await act(async () => answer({ data: recorded(), error: null }));
    expect(screen.queryByText('-2,624.00 Diamonds')).toBeNull();
    testState.userId = '00000000-0000-4000-8000-000000000099';
    rendered.rerender(view());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks missing facts unknown and keeps money independently authoritative', async () => {
    testState.rpc.mockResolvedValue({
      data: recorded({ hands_won: null, vpip_percent: null }),
      error: null,
    });
    render(view());
    act(() => publishSessionSummary(oldMount()));
    await screen.findByText('-2,624.00 Diamonds');
    expect(screen.getAllByText('-')).toHaveLength(2);
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('ignores a pending answer after the authenticated account changes', async () => {
    let answer!: (value: unknown) => void;
    testState.rpc.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const rendered = render(view());
    act(() => publishSessionSummary(oldMount()));
    await waitFor(() => expect(testState.rpc).toHaveBeenCalledTimes(1));
    testState.userId = '00000000-0000-4000-8000-000000000099';
    rendered.rerender(view());
    await act(async () => answer({ data: recorded(), error: null }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('-2,624.00 Diamonds')).toBeNull();
    expect(testState.rpc).toHaveBeenCalledTimes(1);
  });

  it('does not start an old account request after its lazy service finishes loading', async () => {
    const rendered = render(view());
    act(() => publishSessionSummary(oldMount()));
    testState.userId = '00000000-0000-4000-8000-000000000099';
    rendered.rerender(view());
    await act(async () => {
      await import('../../src/services/diamondCashSessionRecap');
    });
    expect(testState.rpc).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a same-account fresh card isolated from its prior ready data', async () => {
    const rendered = render(view());
    act(() => publishSessionSummary(oldMount()));
    await screen.findByText('-2,624.00 Diamonds');
    let answer!: (value: unknown) => void;
    testState.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const next = { ...target, occupancyId: '00000000-0000-4000-8000-000000000007' };
    act(() => publishSessionSummary(oldMount({ diamondRecap: next })));
    rendered.rerender(view());
    expect(screen.getByText('Reading Recorded Session')).toBeTruthy();
    expect(screen.queryByText('-2,624.00 Diamonds')).toBeNull();
    await act(async () =>
      answer({ data: recorded({ occupancy_id: next.occupancyId }), error: null })
    );
    expect(screen.getByText('-2,624.00 Diamonds')).toBeTruthy();
    expect(testState.rpc).toHaveBeenCalledTimes(2);
  });

  it('cannot settle a different pending card before React has rendered its replacement', () => {
    const original = {
      tableId: target.tableId,
      userId: target.userId,
      occupancyId: target.occupancyId,
      sinceMs: 1,
    };
    const replacement = {
      ...original,
      occupancyId: '00000000-0000-4000-8000-000000000007',
      sinceMs: 2,
    };
    publishSessionSummary(oldMount({ plPending: true, pendingCashout: original }));
    publishSessionSummary(oldMount({ plPending: true, pendingCashout: replacement }));
    settlePendingSummary(-999, original);
    expect(peekSessionSummary()?.plPending).toBe(true);
    expect(peekSessionSummary()?.profitLoss).toBe(400);
    settlePendingSummary(-2624, replacement);
    expect(peekSessionSummary()?.plPending).toBe(false);
    expect(peekSessionSummary()?.profitLoss).toBe(-2624);
  });

  it('uses the existing settlement transition for one final reread', async () => {
    testState.rpc.mockResolvedValueOnce({
      data: recorded({ status: 'pending', released_at: null, profit_loss: null }),
      error: null,
    });
    render(view());
    act(() => publishSessionSummary(oldMount({ plPending: true })));
    await screen.findByText('Pending Settlement');
    expect(screen.queryByText('Profit')).toBeNull();
    act(() => settlePendingSummary(-999)); // the mount baseline is immaterial
    await screen.findByText('-2,624.00 Diamonds');
    expect(testState.rpc).toHaveBeenCalledTimes(2);
  });

  it('rejects wrong ownership, financial arithmetic and notification identity', () => {
    expect(parseDiamondCashSessionRecap(recorded({ user_id: 'other' }), target)).toBeNull();
    expect(parseDiamondCashSessionRecap(recorded({ profit_loss: 400 }), target)).toBeNull();
    expect(
      parseDiamondCashSessionRecap(recorded({ notification_id: undefined }), target)
    ).toBeNull();
    expect(
      parseDiamondCashSessionRecap(recorded({ jackpot_awards: 1000, profit_loss: -1624 }), target)
        ?.profitLoss
    ).toBe(-1624);
  });

  it.each([null, undefined, false, true, '', '  ', [], [1], {}])(
    'does not coerce an unknown restored count %s to zero',
    (unknown) => {
      const now = { startMs: 10000, handsPlayed: 20, handsWon: 11, peakStack: 4000 };
      expect(
        mergeSessionFacts({
          serverFacts: { hands_played: unknown, hands_won: unknown },
          atAsk: now,
          now,
        })
      ).toEqual(now);
    }
  );
});
