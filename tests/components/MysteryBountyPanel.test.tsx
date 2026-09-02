/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MYSTERY BOUNTY LOBBY PANEL (Dan sections 31 to 36, 41, 47, 73)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The service tests pin the numbers; these pin that a player can SEE them.
 *
 * The panel takes its data as a prop rather than fetching, which is what makes
 * this a render test instead of a network test: the exact three RPC payloads go
 * in, and the assertions are what a player reads off the screen.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import MysteryBountyPanel from '../../src/components/tournament/MysteryBountyPanel';
import {
  parseInventory,
  parseAwards,
  parseLeaderboard,
} from '../../src/services/MysteryBountyService';
import type { UseMysteryBountyResult } from '../../src/hooks/useMysteryBounty';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
        }),
      }),
    }),
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

/** One 5,000 (won), one 2,000, four 750 (one won), ten 200, twenty 50. */
const INVENTORY = {
  pool_cents: 1300000,
  stage: 'active',
  profile: 'balanced',
  activation: 'player_count',
  activation_value: 27,
  activated_players: 27,
  tiers: [
    { tier: 'jackpot', amount_cents: 500000, original: 1, awarded: 1, remaining: 0 },
    { tier: 'mega', amount_cents: 200000, original: 1, awarded: 0, remaining: 1 },
    { tier: 'major', amount_cents: 75000, original: 4, awarded: 1, remaining: 3 },
    { tier: 'medium', amount_cents: 20000, original: 10, awarded: 0, remaining: 10 },
    { tier: 'base', amount_cents: 5000, original: 20, awarded: 0, remaining: 20 },
  ],
};

const AWARDS = {
  total: 2,
  rows: [
    {
      award_id: 'a2',
      amount_cents: 75000,
      tier: 'major',
      is_jackpot: false,
      revealed_at: '2026-08-25T21:10:00Z',
      hand_id: 'h-303',
      table_id: 't-2',
      eliminated: { user_id: 'u-e2', username: 'Cara' },
      recipients: [{ user_id: 'u-1', username: 'Ann', amount_cents: 75000 }],
    },
    {
      award_id: 'a1',
      amount_cents: 500000,
      tier: 'jackpot',
      is_jackpot: true,
      revealed_at: '2026-08-25T21:05:00Z',
      hand_id: 'h-202',
      table_id: 't-1',
      eliminated: { user_id: 'u-e1', username: 'Dan' },
      recipients: [{ user_id: 'u-2', username: 'Bob', amount_cents: 500000 }],
    },
  ],
};

const LEADERBOARD = {
  rows: [
    { user_id: 'u-2', username: 'Bob', bounties_won: 1, earnings_cents: 500000 },
    { user_id: 'u-1', username: 'Ann', bounties_won: 1, earnings_cents: 75000 },
  ],
};

function makeData(overrides: Partial<UseMysteryBountyResult> = {}): UseMysteryBountyResult {
  const awards = parseAwards(AWARDS);
  return {
    inventory: parseInventory(INVENTORY),
    awards: awards.rows,
    awardsTotal: awards.total,
    leaderboard: parseLeaderboard(LEADERBOARD),
    isLoading: false,
    pendingReveals: 0,
    refresh: vi.fn(),
    ...overrides,
  };
}

function renderPanel(data: UseMysteryBountyResult = makeData()) {
  return render(
    <MysteryBountyPanel
      tournamentId="t-1"
      isMysteryBounty
      data={data}
      currentUserId="u-1"
      isCompleted={false}
    />
  );
}

describe('MysteryBountyPanel', () => {
  it('renders nothing at all for an event that is not a mystery bounty', () => {
    const { container } = render(
      <MysteryBountyPanel tournamentId="t-1" isMysteryBounty={false} data={makeData()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  // ── Section 10 ───────────────────────────────────────────────────────────

  it('advertises the top mystery bounty (section 10)', () => {
    renderPanel();
    expect(screen.getByText('Top Mystery Bounty')).toBeInTheDocument();
    /* 5,000 appears in the headline, the ladder, the award list and the
       leaderboard. All four are correct; the headline is the one asserted. */
    const headline = screen.getByText('Top Mystery Bounty').parentElement!;
    expect(headline).toHaveTextContent('5,000');
    expect(headline).toHaveTextContent('36 Mystery Bounties Drawn From A 13,000 Chip Pool');
  });

  // ── Section 73 ───────────────────────────────────────────────────────────

  it('says the bounties are live once the stage is active (section 73)', () => {
    renderPanel();
    expect(screen.getByText('Mystery Bounties Are Live')).toBeInTheDocument();
  });

  it('says WHY they have not started, before they have (section 73)', () => {
    renderPanel(
      makeData({
        inventory: parseInventory({
          ...INVENTORY,
          stage: 'pending',
          activation: 'at_the_money',
          tiers: [],
        }),
        awards: [],
        leaderboard: [],
      })
    );
    expect(
      screen.getByText(
        'Mystery Bounties Begin After The Rebuy And Add-On Period Ends And The Tournament Reaches The Money'
      )
    ).toBeInTheDocument();
  });

  // ── Sections 31, 32, 33, 47: the ladder ──────────────────────────────────

  it('shows the whole ladder with the original count per tier (sections 31, 32)', () => {
    renderPanel();
    expect(screen.getByText('5,000 x1')).toBeInTheDocument();
    expect(screen.getByText('2,000 x1')).toBeInTheDocument();
    expect(screen.getByText('750 x4')).toBeInTheDocument();
    expect(screen.getByText('200 x10')).toBeInTheDocument();
    expect(screen.getByText('50 x20')).toBeInTheDocument();
  });

  it('shows remaining quantities per tier (section 35)', () => {
    renderPanel();
    expect(screen.getByText('0 Remaining')).toBeInTheDocument();
    expect(screen.getByText('3 Remaining')).toBeInTheDocument();
    expect(screen.getByText('10 Remaining')).toBeInTheDocument();
    expect(screen.getByText('20 Remaining')).toBeInTheDocument();
  });

  it('does NOT hide an exhausted major bounty, and names who won it (section 33)', () => {
    renderPanel();
    /* The 5,000 has zero remaining. It must still be on screen, with its
       original count, its zero, and the name of the player who took it. */
    expect(screen.getByText('5,000 x1')).toBeInTheDocument();
    expect(screen.getByText('0 Remaining')).toBeInTheDocument();
    expect(screen.getByText('Won By Bob')).toBeInTheDocument();
  });

  it('names the tier in words, from the server tier and not from the amount', () => {
    renderPanel();
    expect(screen.getAllByText('Jackpot').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mega Prize').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Major Prize').length).toBeGreaterThan(0);
  });

  // ── Sections 34, 35: the award history ───────────────────────────────────

  it('lists every award with winner, tier, eliminated player and hand (section 34)', () => {
    renderPanel();
    const history = screen.getByText('Mystery Bounties Awarded').closest('section')!;
    expect(within(history).getByText('Bob')).toBeInTheDocument();
    expect(within(history).getByText('Ann')).toBeInTheDocument();
    expect(within(history).getByText(/Knocked Out Dan/)).toBeInTheDocument();
    expect(within(history).getByText(/Hand h-202/)).toBeInTheDocument();
  });

  it('keeps the jackpot visible in the history for the rest of the event (section 35)', () => {
    renderPanel();
    const history = screen.getByText('Mystery Bounties Awarded').closest('section')!;
    expect(within(history).getByText('5,000')).toBeInTheDocument();
    expect(within(history).getByText('Jackpot')).toBeInTheDocument();
  });

  // ── Section 36: the leaderboard ──────────────────────────────────────────

  it('orders the leaderboard by earnings and shows both count and money (section 36)', () => {
    renderPanel();
    const board = screen.getByText('Mystery Bounty Leaderboard').closest('section')!;
    const rows = within(board).getAllByRole('button');
    /* Bob (5,000 from one bounty) above Ann (750 from one bounty). */
    expect(rows[0]).toHaveTextContent('Bob');
    expect(rows[0]).toHaveTextContent('5,000');
    expect(rows[1]).toHaveTextContent('Ann');
    expect(rows[1]).toHaveTextContent('750');
  });

  it('names the largest bounty won so far and who took it (section 68)', () => {
    renderPanel();
    expect(screen.getByText('Largest Mystery Bounty Won: 5,000 By Bob')).toBeInTheDocument();
  });

  it('shows no largest-bounty line before any chest has been opened', () => {
    renderPanel(makeData({ awards: [], awardsTotal: 0, leaderboard: [] }));
    expect(screen.queryByText(/Largest Mystery Bounty Won/)).not.toBeInTheDocument();
  });

  it('says so plainly when nobody has won one yet', () => {
    renderPanel(makeData({ awards: [], awardsTotal: 0, leaderboard: [] }));
    expect(screen.getByText('Nobody Has Won A Mystery Bounty Yet')).toBeInTheDocument();
  });

  // ── Section 68 / 69: reconstruction, not accumulation ────────────────────

  it('reconstructs the same screen from the RPC payloads with no broadcasts seen', () => {
    /* A reload has exactly this: three payloads, zero reveal events. If the
       panel had been accumulating from broadcasts, this render would be empty. */
    const { unmount } = renderPanel();
    const firstLadder = screen.getByText('750 x4').textContent;
    unmount();
    renderPanel(makeData({ pendingReveals: 0 }));
    expect(screen.getByText('750 x4').textContent).toBe(firstLadder);
    expect(screen.getByText('Won By Bob')).toBeInTheDocument();
  });
});
