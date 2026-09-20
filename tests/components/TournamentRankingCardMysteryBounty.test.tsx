/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RESULT CARD AND RESULTS MATH (Dan sections 82.41 to 82.47)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 41. results include the regular prize
 * 42. results include bounty winnings
 * 43. total = prize + bounty
 * 44. a lower finisher can have a larger total than the winner
 * 45 to 47. the result card shows the correct bounty count, earnings and total
 *
 * The card is the EXISTING ranking card, extended. Nothing here re-implements
 * it; the assertions are the four numbers a busted player reads off it.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import TournamentRankingCard from '../../src/components/tournament/TournamentRankingCard';
import type { TournamentResult } from '../../src/services/pendingSessionSummary';
import { CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS } from '../../server/src/tournament/tournamentUnit';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
      }),
    }),
  },
}));

vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => null }));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

/**
 * 14th of 340, min-cashed for 120, and opened a 5,000 chest plus two small ones.
 *
 * The whole point of section 44 in one payload: the placement prize is 120 and
 * the night was worth 5,470.
 */
const LOWER_FINISHER: TournamentResult = {
  name: 'Sunday Mystery',
  finishPlace: 14,
  entrants: 340,
  prize: 120,
  bountyWinnings: 5350,
  knockouts: 4,
  rebuys: 0,
  addOns: 0,
  mysteryBounties: 3,
  mysteryBountyCents: 530000,
  largestMysteryBountyCents: 500000,
  isSpin: false,
};

/** The champion of the same event: 4,200 for the win and one small chest. */
const CHAMPION: TournamentResult = {
  name: 'Sunday Mystery',
  finishPlace: 1,
  entrants: 340,
  prize: 4200,
  bountyWinnings: 150,
  knockouts: 3,
  rebuys: 0,
  addOns: 0,
  mysteryBounties: 1,
  mysteryBountyCents: 15000,
  largestMysteryBountyCents: 15000,
  isSpin: false,
};

/**
 * THE UNIT IS EXPLICIT HERE (2026-09-20), because the card no longer guesses.
 * Every assertion below is a CHIP event and every expected string is unchanged:
 * `moneyAtUnit` returns the card's own `formatMoney` at the chip unit, so the
 * two-place contract these tests were written about is identical. The Diamond
 * half of the same card is pinned at the bottom of this file.
 */
function renderCard(result: TournamentResult, unitCents: number = CHIP_UNIT_CENTS) {
  return render(
    <TournamentRankingCard result={result} onDismiss={vi.fn()} unitCents={unitCents} />
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 41, 42, 43: prize, bounty, and the total that is their sum
// ═══════════════════════════════════════════════════════════════════════════════

describe('41 to 43. the result card carries prize, bounty and total', () => {
  it('labels the headline figure as the TOTAL, not as the prize (section 44)', () => {
    renderCard(LOWER_FINISHER);
    expect(screen.getByText('Total Payout:')).toBeInTheDocument();
  });

  it('shows the regular tournament prize (41)', () => {
    renderCard(LOWER_FINISHER);
    expect(screen.getByText(/Prize/)).toBeInTheDocument();
    expect(screen.getByText('120.00')).toBeInTheDocument();
  });

  it('shows the bounty winnings, separately from the prize (42)', () => {
    renderCard(LOWER_FINISHER);
    expect(screen.getAllByText('5,350.00').length).toBeGreaterThan(0);
  });

  it('shows a total that is exactly prize plus bounty (43)', () => {
    renderCard(LOWER_FINISHER);
    /* 120 + 5,350. Not the prize, not the bounty, the sum. */
    expect(screen.getByText('5,470.00')).toBeInTheDocument();
  });

  it('does not render the split line at all when there is no bounty half', () => {
    renderCard({ ...LOWER_FINISHER, bountyWinnings: 0, mysteryBountyCents: 0, mysteryBounties: 0 });
    expect(screen.queryByText('5,350.00')).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 44: a lower finisher can out-earn the champion
// ═══════════════════════════════════════════════════════════════════════════════

describe('44. a lower finisher can out-earn the champion', () => {
  const total = (r: TournamentResult) => r.prize + r.bountyWinnings;

  it('the arithmetic that the results table sorts on', () => {
    expect(total(LOWER_FINISHER)).toBe(5470);
    expect(total(CHAMPION)).toBe(4350);
    expect(total(LOWER_FINISHER)).toBeGreaterThan(total(CHAMPION));
    /* And on placement prize alone the order is the other way round, which is
       exactly why the total has to be its own column. */
    expect(LOWER_FINISHER.prize).toBeLessThan(CHAMPION.prize);
  });

  it("the champion's card does not present the placement prize as the whole story", () => {
    renderCard(CHAMPION);
    expect(screen.getByText('Total Payout:')).toBeInTheDocument();
    /* 4,200 + 150 = 4,350, and the split beneath names both halves. */
    expect(screen.getByText('4,350.00')).toBeInTheDocument();
    expect(screen.getByText('4,200.00')).toBeInTheDocument();
    expect(screen.getAllByText('150.00').length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 45 to 47: the mystery bounty facts on the card
// ═══════════════════════════════════════════════════════════════════════════════

describe('45 to 47. mystery bounty count, winnings and largest', () => {
  it('shows how many mystery bounties were won', () => {
    renderCard(LOWER_FINISHER);
    const extras = document.querySelector('.trc2__extras')!;
    expect(extras.textContent).toContain('3 Mystery Bounties');
  });

  it('shows the mystery bounty winnings, in chips and not in cents', () => {
    renderCard(LOWER_FINISHER);
    /* 530000 cents is 5,300 chips. A card that forgot to divide would print
       530,000 and report a 5,300 night as a half-million one. */
    expect(screen.getByText('5,300.00')).toBeInTheDocument();
    expect(screen.queryByText('530,000.00')).not.toBeInTheDocument();
  });

  it('shows the largest single mystery bounty', () => {
    renderCard(LOWER_FINISHER);
    expect(screen.getByText('Largest Mystery Bounty')).toBeInTheDocument();
    expect(screen.getByText('5,000.00')).toBeInTheDocument();
  });

  it('says "Bounty" not "Bounties" for a single one', () => {
    renderCard({
      ...LOWER_FINISHER,
      mysteryBounties: 1,
      mysteryBountyCents: 500000,
      largestMysteryBountyCents: 500000,
    });
    const extras = document.querySelector('.trc2__extras')!;
    expect(extras.textContent).toContain('1 Mystery Bounty');
    expect(extras.textContent).not.toContain('1 Mystery Bounties');
  });

  it('renders none of the three for an event with no mystery bounties', () => {
    renderCard({
      ...LOWER_FINISHER,
      mysteryBounties: undefined,
      mysteryBountyCents: undefined,
      largestMysteryBountyCents: undefined,
    });
    expect(screen.queryByText('Largest Mystery Bounty')).not.toBeInTheDocument();
    /* The ordinary bounty line is untouched: an old PKO result still reads the
       way it always did. */
    expect(screen.getAllByText('5,350.00').length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A DIAMOND EVENT'S RESULT CARD (2026-09-20)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Every figure above is a payout, and until this commit every one of them went
// through `formatMoney` - two forced decimal places, the chip contract. At a
// Diamond event that advertises a fraction of a Diamond that no door in this
// estate accepts: the custody reserve floors it, the hand settler refuses it,
// and the wallet stores diamonds as an integer column.
//
// `TournamentRankingHost` reads the unit off the session payload's own arena
// asset, which has already been through `parseArenaIdentity` and therefore
// satisfies all three conditions `fn_ca_tournament_unit_cents` tests.

describe('a Diamond event is denominated in Diamonds on the result card', () => {
  /* The card renders through a portal, so its text is on document.body rather
     than on the render container. */
  const cardText = () => document.body.textContent ?? '';

  it('prints whole Diamonds, with no decimal point anywhere on the card', () => {
    const view = renderCard(LOWER_FINISHER, DIAMOND_UNIT_CENTS);
    const text = cardText();
    view.unmount();
    // 120 prize + 5,350 bounties = 5,470, every figure whole.
    expect(text).toContain('5,470');
    expect(text).toContain('120');
    expect(text).toContain('5,350');
    // 530,000 cents is 5,300 Diamonds; never 530,000 and never 5,300.00.
    expect(text).toContain('5,300');
    expect(text).not.toContain('530,000');
    expect(text).not.toMatch(/\d\.\d\d/);
  });

  it('names the unit on the headline figure, which is otherwise a bare number', () => {
    const view = renderCard(LOWER_FINISHER, DIAMOND_UNIT_CENTS);
    const text = cardText();
    view.unmount();
    expect(text).toContain('5,470 Diamonds');
  });

  it('leaves the chip card exactly as it reads today, which is the whole constraint', () => {
    const view = renderCard(LOWER_FINISHER, CHIP_UNIT_CENTS);
    const text = cardText();
    view.unmount();
    expect(text).toContain('5,470.00');
    expect(text).toContain('120.00');
    expect(text).toContain('5,350.00');
    // And no noun is ADDED to a chip surface that never carried one.
    expect(text).not.toContain('Diamonds');
  });
});
