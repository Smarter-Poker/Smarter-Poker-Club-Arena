import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTournamentAddOnBreak } from '../../src/hooks/useTournamentAddOnBreak';
import TournamentBreakScreen from '../../src/components/table/TournamentBreakScreen';

const fx = vi.hoisted(() => ({
  row: {} as any,
  listener: null as null | (() => void),
  stop: vi.fn(),
  now: 1_000_000,
  error: null as any,
}));
vi.mock('../../src/utils/serverClock', () => ({ serverNow: () => fx.now }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/tournamentStandingsUpdates', () => ({
  subscribeTournamentStandings: (_id: string, cb: () => void) => {
    fx.listener = cb;
    return fx.stop;
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: fx.row, error: fx.error }),
      };
      return chain;
    },
  },
}));
vi.mock('../../src/services/readTournamentStandings', () => ({
  readTournamentStandings: async () => ({ data: [], error: null }),
}));
function Witness({ id = 'event' }: { id?: string }) {
  const notice = useTournamentAddOnBreak(id);
  return <output>{notice ? `${notice.cost}/${notice.chips}/${notice.endsAtMs}` : 'None'}</output>;
}
beforeEach(() => {
  vi.useFakeTimers();
  fx.now = 1_000_000;
  fx.error = null;
  fx.stop.mockClear();
  fx.row = {
    status: 'RUNNING',
    current_level: 8,
    late_reg_levels: 8,
    add_on_available: true,
    addon_from_start: false,
    addon_period_triggered: true,
    addon_period_started_at: new Date(fx.now).toISOString(),
    addon_period_ends_at: new Date(fx.now + 60_000).toISOString(),
    prize_pool_finalized: false,
    addon_cost: 15,
    addon_chips: 20000,
  };
});
afterEach(() => vi.useRealTimers());
const flush = async () => {
  await act(async () => {});
};
describe('every player receives the public add-on break notice', () => {
  it('reads price, grant and deadline without any player purchase eligibility check', async () => {
    const view = render(<Witness />);
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('15/20000/1060000');
    view.unmount();
    expect(fx.stop).toHaveBeenCalledOnce();
  });
  it('refuses an elapsed-clock window while late-entry levels are unfinished', async () => {
    fx.row.current_level = 3;
    render(<Witness />);
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('None');
    fx.row.current_level = 8;
    await act(async () => fx.listener!());
    expect(screen.getByRole('status')).toHaveTextContent('15/20000/1060000');
  });
  it('uses the same legacy cost and chip fallback as the purchase owner', async () => {
    fx.row.addon_cost = null;
    fx.row.addon_chips = null;
    fx.row.buy_in_amount = 25;
    fx.row.starting_chips = 10000;
    render(<Witness />);
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('25/10000/1060000');
  });
  it('never claims the early Free Buy entitlement is a paused break', async () => {
    fx.row.addon_from_start = true;
    fx.row.addon_period_ends_at = new Date(fx.now + 3600000).toISOString();
    render(<Witness />);
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('None');
    fx.row.addon_period_started_at = null;
    fx.row.addon_period_ends_at = null;
    await act(async () => fx.listener!());
    expect(screen.getByRole('status')).toHaveTextContent('None');
    fx.row.addon_period_started_at = new Date(fx.now).toISOString();
    fx.row.addon_period_ends_at = new Date(fx.now + 60000).toISOString();
    await act(async () => fx.listener!());
    expect(screen.getByRole('status')).toHaveTextContent('15/20000/1060000');
  });
  it('shows the final minute of an overlapping regular break and expires on its durable deadline', async () => {
    fx.row.addon_period_ends_at = new Date(fx.now + 300000).toISOString();
    render(<Witness />);
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('None');
    await act(async () => {
      fx.now += 240000;
      vi.advanceTimersByTime(240000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('15/20000/1300000');
    await act(async () => {
      fx.now += 60000;
      vi.advanceTimersByTime(60000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('None');
  });
  it('removes finalized offers and never paints another tournament on a switch', async () => {
    const view = render(<Witness />);
    await flush();
    fx.row.prize_pool_finalized = true;
    await act(async () => fx.listener!());
    expect(screen.getByRole('status')).toHaveTextContent('None');
    view.rerender(<Witness id="other" />);
    expect(screen.getByRole('status')).toHaveTextContent('None');
  });
  it('does not resurrect an unreadable future window and recovers on the next event', async () => {
    fx.row.addon_period_ends_at = new Date(fx.now + 300000).toISOString();
    render(<Witness />);
    await flush();
    fx.error = new Error('Read failed');
    await act(async () => fx.listener!());
    await act(async () => {
      fx.now += 240000;
      vi.advanceTimersByTime(240000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('None');
    fx.error = null;
    await act(async () => fx.listener!());
    expect(screen.getByRole('status')).toHaveTextContent('15/20000/1300000');
  });
  it('opens a new add-on notice even if the previous break was minimized', async () => {
    const props = {
      isVisible: true,
      breakTimeRemaining: 60,
      tournamentName: 'Event',
      nextLevel: { level: 3, smallBlind: 50, bigBlind: 100 },
      breakEndsAtMs: fx.now + 60000,
    };
    const view = render(<TournamentBreakScreen {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(
      <TournamentBreakScreen {...props} addOnNotice={{ cost: 15, chips: 20000, asset: 'chips' }} />
    );
    // A notice needs a stable phase identity independent of its deadline prop.
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText('Add-On Closes In')).toBeVisible();
    expect(screen.getByText('All Tables Paused')).toBeVisible();
    expect(screen.getByText('15')).toBeVisible();
    expect(screen.getByText('20K')).toHaveAttribute('title', '20,000');
    view.rerender(<TournamentBreakScreen {...props} addOnNotice={{ cost: 15, chips: 20000 }} />);
    expect(screen.getByText('Total Cost')).toBeVisible();
    expect(screen.queryByText('Chips Total')).toBeNull();
  });
});
